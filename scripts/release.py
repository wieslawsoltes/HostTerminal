#!/usr/bin/env python3
"""Validate, package and publish a complete Host Terminal GitHub release.

Only ``publish`` accesses GitHub. It stages a draft, checks every uploaded byte,
then publishes; an existing public release or tag is never overwritten.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import struct
import subprocess
import sys
import tomllib
from typing import Any
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TARGETS = (
    "x86_64-unknown-linux-gnu",
    "x86_64-unknown-linux-musl",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
)
VERSION_RE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
GENERATED = {"RELEASE_MANIFEST.json", "SHA256SUMS"}


def require(condition: Any, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def validate_version(version: str) -> str:
    require(bool(VERSION_RE.fullmatch(version)), f"Invalid release version: {version!r}")
    # Chrome's manifest accepts at most 65535 in each numeric version component.
    require(all(int(part) <= 65535 for part in version.split(".")), "Version exceeds Chrome's limit")
    return version


def repository_version(root: Path = ROOT) -> str:
    version = validate_version(read_json(root / "package.json")["version"])
    lock = read_json(root / "package-lock.json")
    cargo = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))
    versions = {
        "package-lock.json": lock["version"],
        "package-lock.json packages root": lock["packages"][""]["version"],
        "extension/manifest.json": read_json(root / "extension/manifest.json")["version"],
        "Cargo.toml workspace": cargo["workspace"]["package"]["version"],
        "Cargo.toml terminal-protocol": cargo["workspace"]["dependencies"]["terminal-protocol"]["version"],
        "Cargo.toml terminal-pty": cargo["workspace"]["dependencies"]["terminal-pty"]["version"],
        "plugin/plugin.json": read_json(root / "plugin/plugin.json")["version"],
        "plugin/.codex-plugin/plugin.json": read_json(root / "plugin/.codex-plugin/plugin.json")["version"],
    }
    cargo_lock = tomllib.loads((root / "Cargo.lock").read_text(encoding="utf-8"))
    for package in cargo_lock["package"]:
        if package["name"] in {"terminal-host", "terminal-pty", "terminal-protocol"}:
            versions[f"Cargo.lock {package['name']}"] = package["version"]
    for name, actual in versions.items():
        require(actual == version, f"Version mismatch: {name} has {actual!r}, expected {version}")
    return version


def release_intent(version: str, env: dict[str, str], request: Any = None) -> None:
    requested = env.get("REQUESTED_VERSION", "").strip()
    if requested:
        require(requested == version, "Requested version does not match checked-in manifests")
    event = env.get("GITHUB_EVENT_NAME", "")
    ref = env.get("GITHUB_REF", "")
    if event == "push" and ref == "refs/heads/main":
        require(request == {"version": version}, "Release request must contain exactly the current version")
        subject = env.get("RELEASE_HEAD_MESSAGE", "").splitlines()
        require(bool(subject) and subject[0] == f"release: v{version}",
                f"A release-request push requires commit subject 'release: v{version}'")
    elif event == "push" and ref.startswith("refs/tags/"):
        require(ref == f"refs/tags/v{version}", "Tag version does not match checked-in manifests")
    elif event == "workflow_dispatch":
        require(ref in {"refs/heads/main", f"refs/tags/v{version}"},
                "Manual publication is allowed only from main or the exact release tag")
    else:
        raise ValueError("Unsupported release event/ref; use --local to check versions without publishing")


def validate(root: Path = ROOT, *, local: bool = False) -> dict[str, str]:
    version = repository_version(root)
    if local:
        print(f"All package manifests agree on {version}")
        return {"version": version, "tag": f"v{version}"}
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    require(bool(SHA_RE.fullmatch(commit)), "Checkout is not a full Git commit SHA")
    require(commit == os.environ.get("GITHUB_SHA"), "Checkout does not match the workflow's exact commit")
    request_file = root / ".github/release-request.json"
    request = read_json(request_file) if request_file.exists() else None
    release_intent(version, dict(os.environ), request)
    outputs = {"version": version, "tag": f"v{version}", "commit": commit}
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8") as stream:
            for key, value in outputs.items():
                stream.write(f"{key}={value}\n")
    print(f"Validated release v{version} at {commit}")
    return outputs


def expected_archives(version: str) -> list[str]:
    validate_version(version)
    return sorted([
        f"host-terminal-native-{version}-{target}.zip" for target in TARGETS
    ] + [
        f"host-terminal-extension-{version}.zip",
        f"host-terminal-chatgpt-plugin-{version}.zip",
        f"host-terminal-{version}.zip",
    ])


def write_checksum(path: Path) -> None:
    path.with_name(path.name + ".sha256").write_text(
        f"{sha256(path)}  {path.name}\n", encoding="utf-8", newline="\n"
    )


def check_binary(data: bytes, target: str) -> None:
    if "linux" in target:
        require(len(data) >= 20 and data[:4] == b"\x7fELF", f"{target}: expected an ELF executable")
        require(data[4:6] == b"\x02\x01" and struct.unpack_from("<H", data, 18)[0] == 62,
                f"{target}: expected a 64-bit little-endian x86 ELF executable")
    elif "apple" in target:
        require(len(data) >= 8 and data[:4] == b"\xcf\xfa\xed\xfe", f"{target}: expected a Mach-O executable")
        cpu = 0x0100000C if target.startswith("aarch64") else 0x01000007
        require(struct.unpack_from("<I", data, 4)[0] == cpu, f"{target}: wrong Mach-O architecture")
    elif "windows" in target:
        require(len(data) >= 64 and data[:2] == b"MZ", f"{target}: expected a PE executable")
        offset = struct.unpack_from("<I", data, 60)[0]
        require(len(data) >= offset + 6 and data[offset:offset + 4] == b"PE\0\0"
                and struct.unpack_from("<H", data, offset + 4)[0] == 0x8664,
                f"{target}: expected an x86-64 PE executable")
    else:
        raise ValueError(f"Unsupported native target {target}")


def pack_native(target: str, binary: Path, directory: Path, root: Path = ROOT) -> Path:
    require(target in TARGETS, f"Unsupported native target {target}")
    version = repository_version(root)
    binary_name = "host-terminal.exe" if "windows" in target else "host-terminal"
    binary_data = binary.read_bytes()
    check_binary(binary_data, target)
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / f"host-terminal-native-{version}-{target}.zip"
    files = {
        binary_name: binary_data,
        **{name: (root / name).read_bytes() for name in (
            "README.md", "LICENSE", "docs/INSTALL.md", "docs/SECURITY.md",
            "native/THIRD_PARTY_NOTICES.txt",
        )},
    }
    if (root / "docs/CHATGPT.md").is_file():
        files["docs/CHATGPT.md"] = (root / "docs/CHATGPT.md").read_bytes()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if name == binary_name else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(info, data, compresslevel=9)
    write_checksum(archive)
    print(f"Created {archive} ({archive.stat().st_size:,} bytes)")
    return archive


def validate_archive(path: Path, version: str) -> None:
    with zipfile.ZipFile(path) as bundle:
        entries = bundle.infolist()
        require(len(entries) <= 10000, f"Too many ZIP entries in {path.name}")
        require(sum(item.file_size for item in entries) <= 1024 * 1024 * 1024,
                f"Oversized expanded ZIP: {path.name}")
        names = [item.filename for item in entries]
        require(len(names) == len(set(names)), f"Duplicate paths in {path.name}")
        for item in entries:
            p = PurePosixPath(item.filename)
            require(not p.is_absolute() and ".." not in p.parts and "\\" not in item.filename
                    and ":" not in item.filename, f"Unsafe ZIP path in {path.name}: {item.filename}")
            require((item.external_attr >> 16) & 0o170000 != 0o120000,
                    f"Symlink in release ZIP: {item.filename}")
        require(bundle.testzip() is None, f"Corrupt ZIP: {path.name}")
        required: set[str]
        if path.name == f"host-terminal-extension-{version}.zip":
            required = {"manifest.json", "terminal.html", "terminal.js", "worker.js"}
            manifest = json.loads(bundle.read("manifest.json"))
            require(manifest.get("version") == version and manifest.get("manifest_version") == 3,
                    "Packaged Chrome manifest version mismatch")
        elif path.name == f"host-terminal-chatgpt-plugin-{version}.zip":
            required = {"plugin.json", "mcp.json", ".codex-plugin/plugin.json", ".mcp.json",
                        "server/index.mjs", "skills/terminal-control/SKILL.md", "LICENSE",
                        "THIRD_PARTY_NOTICES.txt"}
            require(json.loads(bundle.read("plugin.json")).get("version") == version,
                    "Packaged ChatGPT plugin version mismatch")
        elif path.name == f"host-terminal-{version}.zip":
            required = {"host-terminal/package.json", "host-terminal/package-lock.json", "host-terminal/Cargo.lock",
                        "host-terminal/Cargo.toml", "host-terminal/README.md", "host-terminal/LICENSE",
                        "host-terminal/plugin/plugin.json", "host-terminal/plugin/server/index.mjs",
                        "host-terminal/dist/extension/manifest.json", "host-terminal/.github/workflows/release.yml"}
            require(json.loads(bundle.read("host-terminal/package.json")).get("version") == version,
                    "Packaged source version mismatch")
        else:
            target = next((candidate for candidate in TARGETS
                           if path.name == f"host-terminal-native-{version}-{candidate}.zip"), None)
            require(target is not None, f"Unexpected archive: {path.name}")
            binary = "host-terminal.exe" if "windows" in target else "host-terminal"
            required = {binary, "README.md", "LICENSE", "docs/INSTALL.md", "docs/SECURITY.md",
                        "native/THIRD_PARTY_NOTICES.txt"}
            check_binary(bundle.read(binary), target)
            require((bundle.getinfo(binary).external_attr >> 16) & 0o111,
                    f"Executable permission missing in {path.name}")
        require(required.issubset(set(names)), f"Missing files in {path.name}: {sorted(required - set(names))}")
        for name in required:
            require(bundle.getinfo(name).file_size > 0, f"Empty required ZIP entry: {path.name}/{name}")


def assemble(version: str, commit: str, directory: Path) -> dict[str, Any]:
    validate_version(version)
    require(bool(SHA_RE.fullmatch(commit)), "Release commit must be a full lowercase Git SHA")
    names = expected_archives(version)
    expected = set(names) | {name + ".sha256" for name in names}
    actual = {path.name for path in directory.iterdir() if path.name not in GENERATED}
    require(actual == expected, f"Incomplete asset set; missing={sorted(expected - actual)}, extra={sorted(actual - expected)}")
    for name in names:
        path = directory / name
        require(path.is_file() and not path.is_symlink(), f"Asset must be a regular file: {name}")
        checksum = (directory / (name + ".sha256")).read_text(encoding="utf-8")
        require(checksum == f"{sha256(path)}  {name}\n", f"Checksum mismatch for {name}")
        validate_archive(path, version)
    assets = [{"name": name, "size": (directory / name).stat().st_size,
               "sha256": sha256(directory / name)} for name in sorted(expected)]
    manifest = {
        "schemaVersion": 1,
        "version": version,
        "tag": f"v{version}",
        "commit": commit,
        "nativeTargets": list(TARGETS),
        "assets": assets,
    }
    (directory / "RELEASE_MANIFEST.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n"
    )
    checksummed = sorted(expected | {"RELEASE_MANIFEST.json"})
    (directory / "SHA256SUMS").write_text(
        "".join(f"{sha256(directory / name)}  {name}\n" for name in checksummed),
        encoding="utf-8", newline="\n",
    )
    print(f"Validated {len(names)} packages; prepared {len(expected) + 2} release assets for v{version}")
    return manifest


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward a GitHub token to a signed asset storage URL."""
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        require(urllib.parse.urlsplit(newurl).scheme == "https", "Refusing a non-HTTPS asset redirect")
        redirected = super().redirect_request(request, fp, code, msg, headers, newurl)
        if redirected is not None and urllib.parse.urlsplit(request.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


class GitHub:
    def __init__(self, repository: str, token: str):
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository), "Invalid GitHub repository")
        require(bool(token), "GITHUB_TOKEN is required for publication")
        self.repository = repository
        self.base = f"https://api.github.com/repos/{repository}"
        self.token = token
        self.opener = urllib.request.build_opener(SafeRedirect())

    def request(self, method: str, path: str, payload: Any = None, *, optional: bool = False,
                binary: bool = False, data: bytes | None = None) -> Any:
        url = path if path.startswith("https://") else self.base + path
        require(urllib.parse.urlsplit(url).hostname in {"api.github.com", "uploads.github.com"},
                "Refusing to send a token outside GitHub's API hosts")
        headers = {
            "Authorization": f"Bearer {self.token}", "User-Agent": "HostTerminal-release",
            "Accept": "application/octet-stream" if binary else "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif data is not None:
            headers["Content-Type"] = "application/octet-stream"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=120) as response:
                body = response.read()
                return body if binary else (json.loads(body) if body else None)
        except urllib.error.HTTPError as error:
            if optional and error.code == 404:
                return None
            detail = error.read(2048).decode("utf-8", errors="replace")
            raise RuntimeError(f"GitHub {method} {urllib.parse.urlsplit(url).path}: HTTP {error.code}: {detail}") from None

    def assets(self, release_id: int) -> list[dict[str, Any]]:
        return self.request("GET", f"/releases/{release_id}/assets?per_page=100")

    def upload(self, release_id: int, path: Path) -> Any:
        url = f"https://uploads.github.com/repos/{self.repository}/releases/{release_id}/assets?"
        return self.request("POST", url + urllib.parse.urlencode({"name": path.name}), data=path.read_bytes())

    def asset_digest(self, asset: dict[str, Any]) -> str:
        digest = asset.get("digest", "") or ""
        if digest.startswith("sha256:"):
            return digest[7:]
        data = self.request("GET", f"/releases/assets/{asset['id']}", binary=True)
        return hashlib.sha256(data).hexdigest()


def tag_commit(client: GitHub, tag: str) -> str | None:
    reference = client.request("GET", f"/git/ref/tags/{tag}", optional=True)
    if reference is None:
        return None
    obj = reference["object"]
    for _ in range(8):
        if obj["type"] == "commit":
            return obj["sha"]
        require(obj["type"] == "tag", f"Unexpected object type for tag {tag}")
        obj = client.request("GET", f"/git/tags/{obj['sha']}")["object"]
    raise ValueError(f"Tag nesting is too deep: {tag}")


def ensure_tag(client: GitHub, tag: str, commit: str) -> None:
    existing = tag_commit(client, tag)
    require(existing is None or existing == commit,
            f"Refusing to move existing tag {tag} from {existing} to {commit}")
    if existing is None:
        client.request("POST", "/git/refs", {"ref": f"refs/tags/{tag}", "sha": commit})
    require(tag_commit(client, tag) == commit, "Release tag does not resolve to the tested commit")


def find_release(client: GitHub, tag: str) -> dict[str, Any] | None:
    published = client.request("GET", f"/releases/tags/{tag}", optional=True)
    if published is not None:
        return published
    # GitHub documents get-by-tag as a published-release endpoint. The list
    # endpoint includes drafts when called with repository write permission.
    for page in range(1, 101):
        releases = client.request("GET", f"/releases?per_page=100&page={page}")
        matches = [release for release in releases if release["tag_name"] == tag]
        require(len(matches) <= 1, f"Multiple drafts exist for {tag}")
        if matches:
            return matches[0]
        if len(releases) < 100:
            return None
    raise ValueError("Could not exhaust release list while checking for an existing draft")


def verify_remote_assets(client: GitHub, release_id: int, files: dict[str, Path]) -> None:
    assets = client.assets(release_id)
    require(len(assets) == len(files) and {asset["name"] for asset in assets} == set(files),
            "GitHub release asset list does not match the complete local asset set")
    for asset in assets:
        path = files[asset["name"]]
        require(asset["state"] == "uploaded" and asset["size"] == path.stat().st_size,
                f"Incomplete uploaded asset: {path.name}")
        require(client.asset_digest(asset) == sha256(path), f"Uploaded asset checksum mismatch: {path.name}")


def release_body(version: str, repository: str, commit: str) -> str:
    base = f"https://github.com/{repository}/blob/v{version}"
    return f"""<!-- host-terminal-release:{commit} -->
# Host Terminal {version}

Real host terminal sessions in Chrome, with an opt-in ChatGPT/MCP bridge that controls the same native PTYs.

## Downloads

- **Chrome extension:** `host-terminal-extension-{version}.zip`. Extract and load the folder with **Load unpacked** at `chrome://extensions`.
- **Native companion:** choose the `host-terminal-native-{version}-<target>.zip` for Linux x64 (GNU or static musl), macOS (Apple silicon or Intel), or Windows x64. Extract it and follow the included installation guide.
- **ChatGPT/MCP plugin:** `host-terminal-chatgpt-plugin-{version}.zip`, containing the bundled server, manifests and terminal skill. Requires Node.js 22 or later and explicit local bridge enablement.
- **Complete source bundle:** `host-terminal-{version}.zip`, including the built extension and plugin, lockfiles, tests, CI and installation documentation.

[Installation]({base}/docs/INSTALL.md) · [ChatGPT setup]({base}/docs/CHATGPT.md) · [Security model]({base}/docs/SECURITY.md) · [Release process]({base}/docs/RELEASING.md)

Each ZIP has a `.sha256` sidecar. `SHA256SUMS` covers every other release asset; `RELEASE_MANIFEST.json` records package sizes, hashes, native targets and the exact tested commit `{commit}`.

Native binaries are unsigned. This is a GitHub distribution; the extension is installed manually and the ChatGPT integration is connected explicitly by its owner.
"""


def publish(version: str, commit: str, directory: Path, client: GitHub) -> str:
    # Recompute all checksums and archive validation immediately before any API write.
    assemble(version, commit, directory)
    files = {path.name: path for path in directory.iterdir()}
    tag = f"v{version}"
    ensure_tag(client, tag, commit)
    release = find_release(client, tag)
    if release is not None and not release["draft"]:
        verify_remote_assets(client, release["id"], files)
        print(f"Already published; verified existing assets without modifying them: {release['html_url']}")
        return release["html_url"]
    marker = f"<!-- host-terminal-release:{commit} -->"
    if release is None:
        release = client.request("POST", "/releases", {
            "tag_name": tag, "target_commitish": commit, "name": f"Host Terminal {version}",
            "body": release_body(version, client.repository, commit), "draft": True, "prerelease": False,
        })
    else:
        require(marker in (release.get("body") or ""),
                "Refusing to modify a draft not created by this workflow for this commit")
    existing = {asset["name"]: asset for asset in client.assets(release["id"])}
    require(set(existing).issubset(set(files)), "Unexpected assets in the draft release; refusing to delete them")
    for name, path in sorted(files.items()):
        old = existing.get(name)
        if old:
            matches = (old["state"] == "uploaded" and old["size"] == path.stat().st_size
                       and client.asset_digest(old) == sha256(path))
            if matches:
                continue
            # Only our own unfinished draft may be repaired on a retry.
            current = client.request("GET", f"/releases/{release['id']}")
            require(current["draft"] and marker in (current.get("body") or ""),
                    "Release was published or changed during upload; refusing to overwrite an asset")
            client.request("DELETE", f"/releases/assets/{old['id']}")
        client.upload(release["id"], path)
        print(f"Uploaded {name}")
    verify_remote_assets(client, release["id"], files)
    require(tag_commit(client, tag) == commit, "Release tag changed during upload")
    result = client.request("PATCH", f"/releases/{release['id']}", {
        "draft": False, "prerelease": False, "make_latest": "true",
    })
    require(not result["draft"], "GitHub did not publish the staged release")
    verify_remote_assets(client, release["id"], files)
    print(f"Published {result['html_url']}")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(f"## Published [Host Terminal {version}]({result['html_url']})\n\n")
            stream.write(f"Tested commit: `{commit}`. All {len(files)} assets were uploaded and SHA-256 verified.\n")
    return result["html_url"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("validate", help="Check all versions and (unless --local) release intent")
    check.add_argument("--local", action="store_true")
    native = commands.add_parser("pack-native", help="Package one native executable with licenses and documentation")
    native.add_argument("--target", choices=TARGETS, required=True)
    native.add_argument("--binary", type=Path, required=True)
    native.add_argument("--directory", type=Path, default=Path("release"))
    for name in ("assemble", "publish"):
        command = commands.add_parser(name)
        command.add_argument("--version", required=True)
        command.add_argument("--commit", required=True)
        command.add_argument("--directory", type=Path, default=Path("release"))
    args = parser.parse_args()
    if args.command == "validate":
        validate(local=args.local)
    elif args.command == "pack-native":
        pack_native(args.target, args.binary, args.directory)
    elif args.command == "assemble":
        assemble(args.version, args.commit, args.directory)
    elif args.command == "publish":
        client = GitHub(os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GITHUB_TOKEN", ""))
        publish(args.version, args.commit, args.directory, client)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        print(f"Release failed: {error}", file=sys.stderr)
        sys.exit(1)
