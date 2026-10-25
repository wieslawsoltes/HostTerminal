#!/usr/bin/env python3
"""Collect notices for the locked Rust dependency graph before distributing binaries."""
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "native/THIRD_PARTY_NOTICES.txt"
metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--locked", "--offline", "--format-version=1"], cwd=root))
parts = ["Host Terminal — Rust dependency notices\n\n"
         "This inventory covers the locked workspace dependency graph, including build-time and platform-specific packages.\n"
         "Original Host Terminal source is MIT licensed; see LICENSE.\n"]
for package in sorted(metadata["packages"], key=lambda item: (item["name"], item["version"])):
    if package.get("source") is None:
        continue
    directory = Path(package["manifest_path"]).parent
    parts.append(f"\n{'=' * 72}\n{package['name']} {package['version']}\n"
                 f"License expression: {package.get('license') or 'See package license file'}\n"
                 f"Source: {package.get('repository') or package.get('homepage') or 'https://crates.io/crates/' + package['name']}\n")
    candidates = {path for path in directory.iterdir() if path.is_file() and path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE"))}
    if package.get("license_file"):
        candidates.add(directory / package["license_file"])
    for path in sorted(candidates):
        if path.is_file():
            parts.append(f"\n--- {path.name} ---\n{path.read_text(errors='replace')}\n")
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text("".join(parts), encoding="utf-8")
print(output)
