#!/usr/bin/env python3
"""Create a source + ready-to-load extension bundle, with an optional native binary."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--binary", type=Path)
parser.add_argument("--target", default="linux-x64")
args = parser.parse_args()
if not all(char.isalnum() or char in "-_" for char in args.target):
    parser.error("target must be a simple platform name")
version = json.loads((root / "package.json").read_text())["version"]
output = root / "artifacts" / f"host-terminal-{version}.zip"
output.parent.mkdir(exist_ok=True)
names = ["README.md", "START_HERE.md", "LICENSE", "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "tsconfig.json", ".gitignore"]
files = [root / name for name in names]
for directory in ["extension", "crates", "scripts", "tests", "docs", ".github", "dist/extension", "native", "plugin", "mcp", ".agents"]:
    files.extend(path for path in (root / directory).rglob("*") if path.is_file() and "__pycache__" not in path.parts)
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
    for path in sorted(set(files)):
        bundle.write(path, "host-terminal/" + path.relative_to(root).as_posix())
    extension_zip = root / "artifacts" / f"host-terminal-extension-{version}.zip"
    if extension_zip.is_file():
        bundle.write(extension_zip, "host-terminal/" + extension_zip.name)
    plugin_zip = root / "artifacts" / f"host-terminal-chatgpt-plugin-{version}.zip"
    if plugin_zip.is_file():
        bundle.write(plugin_zip, "host-terminal/" + plugin_zip.name)
    if args.binary:
        if not args.binary.is_file():
            parser.error(f"binary does not exist: {args.binary}")
        bundle.write(args.binary, f"host-terminal/native/{args.target}/{args.binary.name}")
with output.open("rb") as file:
    digest = hashlib.file_digest(file, "sha256").hexdigest()
output.with_suffix(".zip.sha256").write_text(f"{digest}  {output.name}\n")
print(output)
print(f"SHA-256: {digest}")
print(f"Bytes: {output.stat().st_size}")
