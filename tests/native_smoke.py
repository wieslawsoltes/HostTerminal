#!/usr/bin/env python3
"""Exercise the installed native executable over real Chrome-style framed pipes.

No user browser registration is changed. Everything is installed under a temporary
directory. POSIX PTY integration; run after `cargo build -p terminal-host`.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("HOST_TERMINAL_BINARY", ROOT / "target/debug/host-terminal")).resolve()
EXTENSION_ID = (ROOT / "extension/EXTENSION_ID").read_text().strip()
ORIGIN = f"chrome-extension://{EXTENSION_ID}/"


class Native:
    def __init__(self, binary: Path, auto_ack: bool = True):
        self.process = subprocess.Popen([str(binary), ORIGIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.messages: queue.Queue = queue.Queue()
        self.events: list[dict] = []
        self.counter = 0
        self.auto_ack = auto_ack
        self.output: dict[str, bytearray] = {}
        self.latest: dict[str, int] = {}
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            while True:
                header = self.process.stdout.read(4)
                if not header:
                    self.messages.put(EOFError("native stdout closed"))
                    return
                if len(header) != 4:
                    raise AssertionError("partial native header")
                size = struct.unpack("=I", header)[0]
                if not 0 < size <= 1024 * 1024:
                    raise AssertionError(f"invalid native frame size {size}")
                payload = self.process.stdout.read(size)
                if len(payload) != size:
                    raise AssertionError("partial native payload")
                self.messages.put(json.loads(payload))
        except Exception as error:
            self.messages.put(error)

    def send(self, message: dict, fragment: bool = False):
        payload = json.dumps(message, ensure_ascii=False).encode()
        data = struct.pack("=I", len(payload)) + payload
        if fragment:
            # Native transports can split a UTF-8 scalar or length header anywhere.
            for index in range(0, len(data), 3):
                self.process.stdin.write(data[index:index + 3])
                self.process.stdin.flush()
        else:
            self.process.stdin.write(data)
            self.process.stdin.flush()

    def next(self, timeout=8):
        message = self.messages.get(timeout=timeout)
        if isinstance(message, Exception):
            raise message
        if message["type"] == "output":
            session_id = message["sessionId"]
            data = base64.b64decode(message["data"], validate=True)
            previous = self.latest.get(session_id, 0)
            assert message["seq"] == previous + len(data), "output byte sequence discontinuity"
            self.latest[session_id] = message["seq"]
            self.output.setdefault(session_id, bytearray()).extend(data)
            if self.auto_ack:
                self.send({"type": "ack", "sessionId": session_id, "seq": message["seq"]})
        if message["type"] != "result":
            self.events.append(message)
        return message

    def request(self, kind: str, *, fragment=False, expect_error=False, **fields):
        self.counter += 1
        identifier = f"test-{self.counter}"
        self.send({"id": identifier, "type": kind, **fields}, fragment=fragment)
        while True:
            message = self.next()
            if message.get("id") == identifier:
                if expect_error:
                    assert message["ok"] is False, message
                    return message["error"]
                assert message["ok"] is True, message
                return message.get("value")

    def until(self, condition, timeout=8):
        deadline = time.monotonic() + timeout
        while not condition():
            self.next(max(0.01, deadline - time.monotonic()))
            if time.monotonic() > deadline:
                raise AssertionError("timed out waiting for terminal condition")

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
                self.process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=5)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()


@unittest.skipIf(os.name == "nt", "POSIX process integration; Windows uses Rust ConPTY tests/CI build")
class Integration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not BINARY.is_file():
            raise RuntimeError("Build first: cargo build -p terminal-host")
        cls.temporary = tempfile.TemporaryDirectory(prefix="host-terminal-test-")
        cls.directory = Path(cls.temporary.name)
        cls.install_dir = cls.directory / "native space Łódź"
        cls.manifest_dir = cls.directory / "browser profile/NativeMessagingHosts"
        cls.options = ["--install-dir", str(cls.install_dir), "--manifest-dir", str(cls.manifest_dir), "--browser", "chromium"]
        subprocess.run([str(BINARY), "install", "--extension-id", EXTENSION_ID, *cls.options], check=True, capture_output=True)
        cls.installed = cls.install_dir / "host-terminal"

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.hosts: list[Native] = []

    def tearDown(self):
        for host in self.hosts:
            host.close()

    def host(self, **options):
        host = Native(self.installed, **options)
        self.hosts.append(host)
        return host

    def test_installer_doctor_and_origin_refusal(self):
        subprocess.run([str(BINARY), "doctor", "--extension-id", EXTENSION_ID, *self.options], check=True, capture_output=True)
        manifest = json.loads((self.manifest_dir / "com.host_terminal.host.json").read_text())
        self.assertEqual(manifest["allowed_origins"], [ORIGIN])
        denied = subprocess.run([str(self.installed), "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"], input=b"", capture_output=True, timeout=5)
        self.assertNotEqual(denied.returncode, 0)
        self.assertEqual(denied.stdout, b"")

    def test_fragmented_unicode_handshake_and_validation(self):
        host = self.host()
        info = host.request("hello", fragment=True)
        self.assertEqual(info["protocol"], 1)
        self.assertEqual(info["limits"]["maxSessions"], 16)
        host.request("create", shell="/bin/sh", args=[], cols=0, rows=24, expect_error=True)
        host.request("eval", command="no", expect_error=True)
        self.assertEqual(host.request("list"), [])

    def test_real_pty_unicode_resize_input_exit_and_final_output(self):
        host = self.host()
        script = "stty -echo; printf 'READY\\n'; read line; stty size; printf 'VALUE:%s\\n' \"$line\"; printf '\\033[31mFINAL\\033[0m\\n'; exit 7"
        session = host.request("create", shell="/bin/sh", args=["-c", script], cwd=str(self.directory), title="Łódź terminal", cols=80, rows=24)
        sid = session["id"]
        host.until(lambda: b"READY" in host.output.get(sid, b""))
        host.request("resize", sessionId=sid, cols=113, rows=37)
        text = "Zażółć 🦀 漢字"
        host.request("input", sessionId=sid, data=base64.b64encode((text + "\r").encode()).decode())
        host.until(lambda: any(e["type"] == "exit" and e["sessionId"] == sid for e in host.events))
        data = bytes(host.output[sid])
        self.assertIn(b"37 113", data)
        self.assertIn(("VALUE:" + text).encode(), data)
        self.assertIn(b"\x1b[31mFINAL\x1b[0m", data)
        self.assertEqual(host.events[-1]["type"], "exit")
        self.assertEqual(host.events[-1]["exitCode"], 7)
        host.request("close", sessionId=sid)
        self.assertEqual(host.request("list"), [])

    def test_bounded_output_blocks_until_ack_and_close_still_works(self):
        host = self.host(auto_ack=False)
        session = host.request("create", shell="/bin/sh", args=["-c", "exec yes x"], cols=80, rows=24)
        sid = session["id"]
        host.until(lambda: host.latest.get(sid, 0) >= 262144)
        self.assertEqual(host.latest[sid], 262144)
        self.assertEqual(len(host.request("list")), 1)  # control lane still responds
        host.request("ack", sessionId=sid, seq=262145, expect_error=True)
        host.request("ack", sessionId=sid, seq=262144)
        host.until(lambda: host.latest.get(sid, 0) > 262144)
        host.request("close", sessionId=sid)
        self.assertEqual(host.request("list"), [])

    def test_disconnect_terminates_shell_and_foreground_job(self):
        host = self.host()
        session = host.request("create", shell="/bin/sh", args=["-c", "printf 'PID:%s\\n' $$; exec sleep 100"], cols=80, rows=24)
        sid = session["id"]
        host.until(lambda: b"PID:" in host.output.get(sid, b""))
        pid = session["pid"]
        host.process.stdin.close()
        host.process.wait(timeout=5)
        self.assertEqual(host.process.returncode, 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_two_sessions_isolation_and_explicit_shutdown(self):
        host = self.host()
        sessions = [host.request("create", shell="/bin/sh", args=["-c", f"printf '{name}\\n'; exec sleep 100"], cols=80, rows=24) for name in ("FIRST", "SECOND")]
        host.until(lambda: all(s["id"] in host.output for s in sessions))
        self.assertIn(b"FIRST", host.output[sessions[0]["id"]])
        self.assertNotIn(b"SECOND", host.output[sessions[0]["id"]])
        host.request("rename", sessionId=sessions[0]["id"], title="Renamed 🦀")
        self.assertIn("Renamed 🦀", [s["title"] for s in host.request("list")])
        host.request("shutdown")
        host.process.wait(timeout=5)
        self.assertEqual(host.process.returncode, 0)
        for session in sessions:
            with self.assertRaises(ProcessLookupError):
                os.kill(session["pid"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
