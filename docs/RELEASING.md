# Building and publishing releases

Host Terminal is distributed through [GitHub Releases](https://github.com/wieslawsoltes/HostTerminal/releases). The release workflow builds the extension, the ChatGPT/MCP plugin, the complete source distribution and five native companions from one tested commit. It uploads and verifies every asset before making the release public.

The workflow uses GitHub's repository-scoped `GITHUB_TOKEN`. No personal access token or manually uploaded binary is required. Only the final publication job has `contents: write`; tests and package builds have read access.

## Release contents

For version `0.2.0`, the required packages are:

| Artifact | Contents / target |
| --- | --- |
| `host-terminal-extension-0.2.0.zip` | Built Manifest V3 extension; extract and load the directory in Chrome |
| `host-terminal-chatgpt-plugin-0.2.0.zip` | Portable and Codex plugin manifests, bundled MCP server, terminal skill, license and dependency notices |
| `host-terminal-0.2.0.zip` | Source, lockfiles, tests, build scripts, workflows, documentation and the built extension/plugin |
| `host-terminal-native-0.2.0-x86_64-unknown-linux-gnu.zip` | Linux x64 native companion built on Ubuntu 24.04 |
| `host-terminal-native-0.2.0-x86_64-unknown-linux-musl.zip` | Static musl Linux x64 native companion |
| `host-terminal-native-0.2.0-aarch64-apple-darwin.zip` | macOS Apple silicon native companion |
| `host-terminal-native-0.2.0-x86_64-apple-darwin.zip` | macOS Intel native companion |
| `host-terminal-native-0.2.0-x86_64-pc-windows-msvc.zip` | Windows x64 native companion with ConPTY support |

Every ZIP has a `.sha256` sidecar. `RELEASE_MANIFEST.json` records the version, exact commit, native targets, sizes and SHA-256 hashes of all eight packages and their sidecars. `SHA256SUMS` also covers the manifest. There are **18 uploaded release assets** in total, in addition to GitHub's automatically generated source archives.

Native ZIPs include the executable, installation/security documentation, project license and Rust dependency notices. UNIX executable permission bits are preserved in the ZIP. If an extraction utility drops those bits, run `chmod +x host-terminal` before installation.

The GNU Linux binary uses the runner's system libraries; choose the static musl build when system compatibility is a concern. The first release does not provide ARM Linux/Windows binaries, signed or notarized native applications, a Chrome Web Store listing, or a hosted ChatGPT service. Plugin setup and bridge enablement are described in [CHATGPT.md](CHATGPT.md).

## Required checks

`.github/workflows/ci.yml` runs on branch pushes, pull requests and manual dispatch. It is also a required reusable workflow in every release run.

- Rust formatting, Clippy with warnings denied, workspace tests and release builds run on Ubuntu 24.04, Windows Server 2022, macOS 15 Apple silicon and macOS 15 Intel.
- POSIX jobs exercise a real PTY and Native Messaging framing through the compiled companion.
- TypeScript checks, extension/broker tests and MCP tests run on Node.js 22. Both the extension and plugin must build and package successfully.
- Chromium runs the extension against an installed native companion in an isolated test profile.
- Release automation tests exercise missing/corrupt packages, version drift, native architecture validation, immutable tags, draft recovery and protection of published assets.

Release builds then test and compile each exact target, including musl, before packaging it. The toolchain is pinned to Rust 1.89.0, matching the workspace's declared minimum; scripts use Python 3.12. Dependency installation uses `npm ci`, and Cargo commands use the checked-in lockfile with `--locked`.

## Prepare a new version

Keep these values synchronized:

1. `package.json` and both root-version fields in `package-lock.json`.
2. `extension/manifest.json`.
3. `Cargo.toml`: workspace package version and internal dependency versions.
4. `Cargo.lock`: `terminal-host`, `terminal-pty` and `terminal-protocol` package versions.
5. `plugin/plugin.json` and `plugin/.codex-plugin/plugin.json`.
6. `VERSION` in `mcp/tools.mjs`; rebuild and commit `plugin/server/index.mjs` and its dependency notices. The MCP test checks server/plugin/package version consistency.

Use stable numeric `major.minor.patch` versions, with each component no greater than 65535 to fit Chrome's manifest format. Update user-facing installation and release notes when behavior changes.

Run the normal checks and inspect the packaged output before requesting publication:

```sh
npm ci
npm run check
npm run build:plugin
npm run package
npm run package:plugin
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
python3 scripts/release.py validate --local
python3 scripts/release_tests.py
```

`validate --local` checks version consistency without reading credentials or accessing GitHub. The release tests use a fake API and never make network requests.

## Publish from main

The recommended path, including the first release, is a deliberate release-request commit on `main`:

1. Merge the complete implementation and wait for **Build and test** to pass.
2. Write `.github/release-request.json` containing exactly the version to publish:

   ```json
   {"version":"0.2.0"}
   ```

3. Commit that file with the exact subject `release: v0.2.0` and push to `main`.

The **Release packages** workflow is triggered only when this request file changes on `main`. It checks the request, commit subject, all package versions and the checked-out SHA. It reruns every required CI check for this exact release commit, builds all eight packages, validates ZIP structure and native executable architectures, and calculates all checksums.

After all jobs succeed, the publication job:

1. Creates `v0.2.0` at the tested commit, or verifies an existing tag already points there.
2. Creates a draft release as an upload staging area.
3. Uploads all 18 assets and verifies their sizes and SHA-256 digests through GitHub's API.
4. Publishes the complete release and makes it the latest release.

No draft approval step is required. A successful run ends with a public release and a link in the workflow's job summary. A tag created by the workflow uses `GITHUB_TOKEN`, so it does not start a recursive release run.

For the first repository push, leave out `.github/release-request.json` until the baseline CI has passed. For later versions, change its version in a new matching release commit. Merely changing other source files does not request publication.

### Alternative triggers

You can push a `v<version>` tag or manually run **Release packages** from the Actions tab. A tag must match every manifest. Manual dispatch accepts an optional version and permits only `main` or the matching version tag. The supplied version, when present, must match the checked-in source; it is not a version override.

All trigger paths use the same checks, packaging and publication procedure. No existing tag is moved.

## Failed runs and retries

If tests or package validation fail, no release tag or release is created by the workflow. Fix the source and request a release from a new tested commit. If a manually pushed tag already exists at an incorrect commit, publish a new version; the workflow will not move it.

If an upload fails after the tag is created, the release remains an unpublished draft. Rerun the failed jobs for the **same commit**. The publisher recognizes drafts it created using a commit marker, preserves correct uploads and repairs incomplete or incorrect uploads inside that draft. It refuses to modify someone else's draft or delete unrecognized assets.

If the release has already been published, a retry only verifies the existing asset set against the rebuilt files. It never changes or replaces a public asset. If the rebuilt bytes differ, the run reports the difference and leaves the public release intact. Publish a new version for any correction to shipped code.

Release runs are serialized and are not automatically canceled halfway through publication. If repository policies restrict tag creation or `GITHUB_TOKEN` write permissions, GitHub reports the restriction in the publication job; the workflow cannot bypass those policies.

## Verify downloaded artifacts

Download the ZIPs and `SHA256SUMS` into the same directory. On Linux:

```sh
sha256sum --check SHA256SUMS
```

On macOS:

```sh
shasum -a 256 --check SHA256SUMS
```

On Windows PowerShell, compare the calculated hash with the package's `.sha256` sidecar:

```powershell
Get-FileHash .\host-terminal-native-0.2.0-x86_64-pc-windows-msvc.zip -Algorithm SHA256
Get-Content .\host-terminal-native-0.2.0-x86_64-pc-windows-msvc.zip.sha256
```

These checks detect corrupted or changed downloads. They are checksums, not code signatures. Use the release attached to the intended repository and tag, and compare `RELEASE_MANIFEST.json`'s commit with the workflow run.

## Build native packages locally

After building a supported target, fetch dependency licenses and run the same packager used by CI:

```sh
cargo build --release --target x86_64-unknown-linux-musl --locked -p terminal-host
cargo fetch --locked
python3 scripts/third_party.py
python3 scripts/release.py pack-native \
  --target x86_64-unknown-linux-musl \
  --binary target/x86_64-unknown-linux-musl/release/host-terminal
```

`pack-native` rejects a binary with the wrong executable format or CPU architecture. It does not install the companion or invoke its shell. To assemble a complete release locally, put all eight ZIPs and their sidecars in `release/`, then run:

```sh
python3 scripts/release.py assemble \
  --version 0.2.0 \
  --commit "$(git rev-parse HEAD)" \
  --directory release
```

The `assemble` command is entirely local. Only the `publish` command writes to GitHub, and it is normally invoked by the gated workflow rather than by a developer workstation.

## References

- [GitHub-hosted runner labels and architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub release REST endpoints](https://docs.github.com/en/rest/releases/releases)
- [GitHub release assets and SHA-256 digests](https://docs.github.com/en/rest/releases/assets)
