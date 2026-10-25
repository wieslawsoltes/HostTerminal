#!/usr/bin/env python3
"""Exercise release safety boundaries without credentials or network access."""
from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
import urllib.request
import zipfile

import release

VERSION = "0.2.0"
COMMIT = "a" * 40


def executable(target: str) -> bytes:
    data = bytearray(256)
    if "linux" in target:
        data[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", data, 18, 62)
    elif "apple" in target:
        data[:4] = b"\xcf\xfa\xed\xfe"
        struct.pack_into("<I", data, 4, 0x0100000C if target.startswith("aarch64") else 0x01000007)
    else:
        data[:2] = b"MZ"
        struct.pack_into("<I", data, 60, 128)
        data[128:132] = b"PE\0\0"
        struct.pack_into("<H", data, 132, 0x8664)
    return bytes(data)


def fixture_assets(directory: Path) -> None:
    for name in release.expected_archives(VERSION):
        if "-native-" in name:
            target = next(target for target in release.TARGETS if target in name)
            binary = "host-terminal.exe" if "windows" in target else "host-terminal"
            files = {binary: executable(target), **{path: b"Documentation\n" for path in (
                "README.md", "LICENSE", "docs/INSTALL.md", "docs/SECURITY.md", "native/THIRD_PARTY_NOTICES.txt")}}
        elif "-extension-" in name:
            files = {"manifest.json": json.dumps({"version": VERSION, "manifest_version": 3}).encode(),
                     "terminal.html": b"<html></html>", "terminal.js": b"// terminal", "worker.js": b"// worker"}
        elif "-chatgpt-plugin-" in name:
            files = {path: b"Content\n" for path in ("plugin.json", "mcp.json", ".codex-plugin/plugin.json", ".mcp.json",
                "server/index.mjs", "skills/terminal-control/SKILL.md", "LICENSE", "THIRD_PARTY_NOTICES.txt")}
            files["plugin.json"] = json.dumps({"version": VERSION}).encode()
        else:
            files = {f"host-terminal/{path}": b"Content\n" for path in ("package.json", "package-lock.json", "Cargo.lock",
                "Cargo.toml", "README.md", "LICENSE", "plugin/plugin.json", "plugin/server/index.mjs",
                "dist/extension/manifest.json", ".github/workflows/release.yml")}
            files["host-terminal/package.json"] = json.dumps({"version": VERSION}).encode()
        path = directory / name
        with zipfile.ZipFile(path, "w") as bundle:
            for filename, content in files.items():
                info = zipfile.ZipInfo(filename)
                info.create_system = 3
                info.external_attr = (0o100755 if filename in {"host-terminal", "host-terminal.exe"} else 0o100644) << 16
                bundle.writestr(info, content)
        release.write_checksum(path)


class FakeGitHub:
    repository = "owner/HostTerminal"

    def __init__(self):
        self.tag = None
        self.release = None
        self.uploaded = {}
        self.writes = []
        self.corrupt_upload = False
        self.next_id = 10

    def request(self, method, path, payload=None, *, optional=False, **kwargs):
        if method != "GET":
            self.writes.append((method, path))
        if path.startswith("/git/ref/tags/") and method == "GET":
            return {"object": {"type": "commit", "sha": self.tag}} if self.tag else None
        if path == "/git/refs" and method == "POST":
            self.tag = payload["sha"]
            return {}
        if path.startswith("/releases/tags/") and method == "GET":
            return copy.deepcopy(self.release) if self.release and not self.release["draft"] else None
        if path.startswith("/releases?per_page=") and method == "GET":
            return [copy.deepcopy(self.release)] if self.release else []
        if path == "/releases" and method == "POST":
            self.release = {**payload, "id": 1, "html_url": "https://github.com/owner/HostTerminal/releases/tag/v0.2.0"}
            return copy.deepcopy(self.release)
        if path == "/releases/1" and method == "GET":
            return copy.deepcopy(self.release)
        if path == "/releases/1" and method == "PATCH":
            self.release.update(payload)
            return copy.deepcopy(self.release)
        if path.startswith("/releases/assets/") and method == "DELETE":
            asset_id = int(path.rsplit("/", 1)[1])
            self.uploaded = {name: asset for name, asset in self.uploaded.items() if asset["id"] != asset_id}
            return None
        raise AssertionError(f"Unexpected fake API request {method} {path}")

    def assets(self, release_id):
        return list(copy.deepcopy(self.uploaded).values())

    def upload(self, release_id, path):
        self.writes.append(("UPLOAD", path.name))
        self.next_id += 1
        self.uploaded[path.name] = {"id": self.next_id, "name": path.name, "state": "uploaded",
            "size": path.stat().st_size, "digest": "sha256:" + ("0" * 64 if self.corrupt_upload else release.sha256(path))}
        return self.uploaded[path.name]

    def asset_digest(self, asset):
        return asset["digest"].removeprefix("sha256:")


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        fixture_assets(self.directory)
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()

    def tearDown(self):
        self.output.__exit__(None, None, None)
        self.temp.cleanup()

    def test_manifest_covers_all_eight_packages_and_sidecars(self):
        manifest = release.assemble(VERSION, COMMIT, self.directory)
        self.assertEqual(len(manifest["assets"]), 16)
        self.assertEqual(manifest["commit"], COMMIT)
        self.assertEqual(len(list(self.directory.iterdir())), 18)
        for line in (self.directory / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ", 1)
            self.assertEqual(digest, release.sha256(self.directory / name))

    def test_release_intent_requires_deliberate_main_commit(self):
        env = {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/heads/main", "RELEASE_HEAD_MESSAGE": "fix: unrelated"}
        with self.assertRaisesRegex(ValueError, "commit subject"):
            release.release_intent(VERSION, env, {"version": VERSION})
        env["RELEASE_HEAD_MESSAGE"] = "release: v0.2.0\n\nRelease all artifacts"
        release.release_intent(VERSION, env, {"version": VERSION})
        with self.assertRaisesRegex(ValueError, "Release request"):
            release.release_intent(VERSION, env, {"version": "0.1.0"})

    def test_tag_and_dispatch_cannot_publish_another_version_or_branch(self):
        with self.assertRaisesRegex(ValueError, "Tag version"):
            release.release_intent(VERSION, {"GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/tags/v9.0.0"})
        with self.assertRaisesRegex(ValueError, "only from main"):
            release.release_intent(VERSION, {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/feature"})
        release.release_intent(VERSION, {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF": "refs/heads/main"})

    def test_manifest_version_drift_is_rejected(self):
        root = self.directory / "repository"
        for name in ("package.json", "package-lock.json", "Cargo.toml", "Cargo.lock", "extension/manifest.json",
                     "plugin/plugin.json", "plugin/.codex-plugin/plugin.json"):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(release.ROOT / name, path)
        plugin = json.loads((root / "plugin/plugin.json").read_text())
        plugin["version"] = "65535.0.0"
        (root / "plugin/plugin.json").write_text(json.dumps(plugin))
        with self.assertRaisesRegex(ValueError, "Version mismatch"):
            release.repository_version(root)

    def test_missing_asset_prevents_any_remote_mutation(self):
        (self.directory / release.expected_archives(VERSION)[0]).unlink()
        api = FakeGitHub()
        with self.assertRaisesRegex(ValueError, "Incomplete asset set"):
            release.publish(VERSION, COMMIT, self.directory, api)
        self.assertEqual(api.writes, [])

    def test_corrupt_checksum_prevents_any_remote_mutation(self):
        path = self.directory / release.expected_archives(VERSION)[0]
        with path.open("ab") as stream:
            stream.write(b"changed")
        api = FakeGitHub()
        with self.assertRaisesRegex(ValueError, "Checksum mismatch"):
            release.publish(VERSION, COMMIT, self.directory, api)
        self.assertEqual(api.writes, [])

    def test_unsafe_archive_path_is_rejected_even_with_a_valid_checksum(self):
        path = self.directory / f"host-terminal-extension-{VERSION}.zip"
        with zipfile.ZipFile(path, "a") as bundle:
            bundle.writestr("../outside", "unsafe")
        release.write_checksum(path)
        with self.assertRaisesRegex(ValueError, "Unsafe ZIP path"):
            release.assemble(VERSION, COMMIT, self.directory)

    def test_wrong_native_architecture_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "wrong Mach-O architecture"):
            release.check_binary(executable("x86_64-apple-darwin"), "aarch64-apple-darwin")
        with self.assertRaisesRegex(ValueError, "ELF executable"):
            release.check_binary(executable("x86_64-pc-windows-msvc"), "x86_64-unknown-linux-gnu")

    def test_existing_tag_cannot_move(self):
        api = FakeGitHub()
        api.tag = "b" * 40
        with self.assertRaisesRegex(ValueError, "Refusing to move"):
            release.publish(VERSION, COMMIT, self.directory, api)
        self.assertEqual(api.writes, [])

    def test_publication_happens_after_every_upload_is_verified(self):
        api = FakeGitHub()
        release.publish(VERSION, COMMIT, self.directory, api)
        self.assertEqual(api.tag, COMMIT)
        self.assertFalse(api.release["draft"])
        self.assertEqual(len(api.uploaded), 18)
        self.assertEqual(api.writes[-1], ("PATCH", "/releases/1"))

    def test_failed_upload_verification_keeps_release_draft(self):
        api = FakeGitHub()
        api.corrupt_upload = True
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            release.publish(VERSION, COMMIT, self.directory, api)
        self.assertTrue(api.release["draft"])
        self.assertNotIn(("PATCH", "/releases/1"), api.writes)
        # A retry locates the unpublished draft through list-releases and repairs
        # only assets in this workflow's own unfinished draft.
        api.corrupt_upload = False
        release.publish(VERSION, COMMIT, self.directory, api)
        self.assertFalse(api.release["draft"])
        self.assertEqual(api.writes.count(("POST", "/releases")), 1)

    def test_foreign_draft_is_never_overwritten(self):
        api = FakeGitHub()
        api.tag = COMMIT
        api.release = {"id": 1, "tag_name": f"v{VERSION}", "draft": True, "body": "Manually prepared draft"}
        with self.assertRaisesRegex(ValueError, "draft not created"):
            release.publish(VERSION, COMMIT, self.directory, api)
        self.assertEqual(api.writes, [])

    def test_existing_public_release_is_only_verified(self):
        api = FakeGitHub()
        release.publish(VERSION, COMMIT, self.directory, api)
        api.writes.clear()
        release.publish(VERSION, COMMIT, self.directory, api)
        self.assertEqual(api.writes, [])
        next(iter(api.uploaded.values()))["digest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            release.publish(VERSION, COMMIT, self.directory, api)
        self.assertEqual(api.writes, [])

    def test_asset_redirect_drops_token(self):
        request = urllib.request.Request("https://api.github.com/repos/owner/repo/releases/assets/1",
                                         headers={"Authorization": "Bearer fake-secret"})
        redirected = release.SafeRedirect().redirect_request(request, None, 302, "Found", {},
                                                             "https://release-assets.githubusercontent.com/file")
        self.assertIsNone(redirected.get_header("Authorization"))
        with self.assertRaisesRegex(ValueError, "non-HTTPS"):
            release.SafeRedirect().redirect_request(request, None, 302, "Found", {}, "http://example.com/file")


if __name__ == "__main__":
    unittest.main(verbosity=2)
