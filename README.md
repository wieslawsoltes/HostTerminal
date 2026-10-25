# Host Terminal

[![Build and test](https://github.com/wieslawsoltes/HostTerminal/actions/workflows/ci.yml/badge.svg)](https://github.com/wieslawsoltes/HostTerminal/actions/workflows/ci.yml)
[![Release](https://github.com/wieslawsoltes/HostTerminal/actions/workflows/release.yml/badge.svg)](https://github.com/wieslawsoltes/HostTerminal/actions/workflows/release.yml)

A real desktop terminal inside Google Chrome, with a Manifest V3 extension, an xterm.js workspace, and a Rust native companion. Shells run on the computer that runs Chrome, with that user's normal filesystem, processes, network access, SSH configuration, and development tools.

This is an extension plus a native application. Chrome's extension sandbox cannot launch host processes by itself. The companion uses [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), with an optional ChatGPT/MCP plugin that controls the same sessions through an explicitly enabled, authenticated loopback bridge. Ordinary web pages have no terminal command API.

## Capabilities

- Real pseudoterminals through `portable-pty`: Unix PTYs on Linux/macOS and Windows ConPTY.
- Multiple independent sessions, split terminal views, and session titles.
- Interactive shells and full-screen terminal applications; run installed tools such as `ssh`, `git`, `vim`, `tmux`, build systems, and REPLs normally.
- Shell profiles with executable, argument array, initial directory, and environment overrides.
- Local preferences for terminal appearance, font, cursor, and scrollback.
- Terminal search, selection/copy/paste, multiline paste review, and transcript export.
- A companion installer, diagnostics, extension authorization, and uninstallation for the current OS user.
- Exact extension-origin checks, bounded protocol frames, raw byte preservation, and acknowledgement-based output flow control.
- A ChatGPT plugin with 10 MCP tools: status, list, create, read, write, interrupt, resize, rename, close, and run. Agent-created sessions appear in Chrome; access can be revoked without closing your terminals.
- Bundled local stdio MCP server, optional authenticated localhost HTTP transport, and setup for OpenAI Secure MCP Tunnel.
- A reusable Rust protocol crate, PTY/session crate, and native host library; the executable adds installation and Chrome integration.

Sessions can survive closing the terminal page while Chrome and its native connection remain alive. They are not a system daemon and do not survive a browser restart, extension reload, native-host crash, or OS restart. Reattaching replays a bounded recent byte stream; it does not reconstruct an exact historical terminal screen. For durable remote or local sessions, run `tmux` or another multiplexer inside the terminal.

## Download and install

Download the [latest release](https://github.com/wieslawsoltes/HostTerminal/releases/latest). Each release includes the ready-to-load Chrome extension, native companions for Linux/macOS/Windows, a self-contained ChatGPT plugin, and a complete source bundle. The plugin needs Node.js 22 or newer; ordinary terminal use needs only the extension and matching native companion.

1. Extract `host-terminal-extension-<version>.zip` and load its folder at `chrome://extensions` → **Developer mode** → **Load unpacked**.
2. Extract the native ZIP matching your OS and architecture. Run its `host-terminal install --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh --browser chrome` command (`host-terminal.exe` on Windows).
3. Open the extension and select **Connect to this computer**.
4. For ChatGPT, follow [the integration guide](docs/CHATGPT.md), then choose the plug icon → **Enable ChatGPT access** in Chrome.

See [START_HERE.md](START_HERE.md) for platform-specific commands and [installation troubleshooting](docs/INSTALL.md). Linux users can choose the static musl package to avoid a host glibc version dependency. Native release packages are unsigned.

## Build from source

You need a current desktop Chrome, Node.js 22 or newer, and the stable Rust toolchain. Windows native builds also need the Microsoft C++ build tools and Windows SDK. Use the same OS/architecture as the computer where you will run Chrome.

```sh
npm ci
npm run build
npm run build:plugin
cargo build --release --locked
```

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this project's `dist/extension` directory.
2. Copy the extension ID from Chrome. The supplied public key gives the unpacked build the stable ID `pcgpjpaehgkbjinhohohlpcbgfhmkilh`.
3. Install the native companion for that exact ID.

**Linux or macOS:**

```sh
./target/release/host-terminal install \
  --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh \
  --browser chrome

./target/release/host-terminal doctor \
  --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh
```

**Windows PowerShell:**

The prebuilt Windows companion requires the [Microsoft Visual C++ v14 Redistributable (x64)](https://aka.ms/vc14/vc_redist.x64.exe). Install it if Windows reports that `VCRUNTIME140.dll` is missing.

```powershell
.\target\release\host-terminal.exe install `
  --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh `
  --browser chrome

.\target\release\host-terminal.exe doctor `
  --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh
```

4. Open Host Terminal from the extension button and choose **Connect**. Create a terminal using your default shell or a saved profile.

The installer copies the executable to a stable location in your user account and registers its absolute path. Moving the source checkout afterwards does not break the installed host. Running `install` again updates the binary and preserves other authorized IDs; close active sessions first.

For a packaged native binary, substitute `./host-terminal` or `.\host-terminal.exe` for the build path above. For an extension ZIP, extract it and load the directory containing `manifest.json`. ZIP files are not loaded directly by Chrome's **Load unpacked** action.

## Supported environments

| Environment | Design / packaging |
| --- | --- |
| Linux desktop | Native PTY; x86-64 GNU/Linux and static musl release targets |
| macOS desktop | Native PTY; Apple Silicon and Intel release targets |
| Windows 10 1809+ / Windows 11 | ConPTY; x86-64 MSVC release target |
| Chromium, Edge, Brave | Explicit installer browser targets; primary UX targets Chrome |
| Chrome for Testing | Dedicated Linux/macOS paths; `--manifest-dir` supports custom profiles |

Chrome on iOS/Android and a ChromeOS Linux container are not supported host-installation targets for this extension. Installing the extension on one computer does not grant access to a different computer; use ordinary SSH inside the shell for remote access.

See the [workflow runs](https://github.com/wieslawsoltes/HostTerminal/actions) and [validation report](docs/VALIDATION.md) for executed checks. Browser integration currently runs on Linux Chromium; native tests run on Windows, both Mac architectures, and Linux. Artifacts are unsigned; platform signing can be added to your distribution pipeline.

## Development

```sh
npm run typecheck
npm test
npm run test:mcp
npm run build
npm run build:plugin
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --release --locked
npm run package
npm run package:plugin
```

`npm run package` and `npm run package:plugin` produce archives under `artifacts/`. GitHub Actions tests all supported desktop platforms and the real Chrome-to-PTY-to-MCP path. The release workflow stages and verifies all eight ZIPs, checksum sidecars, and release metadata before publishing. See [RELEASING.md](docs/RELEASING.md) for the versioned release request. GitHub publication does not submit to the Chrome Web Store or OpenAI Plugin Directory.

| Area | Location |
| --- | --- |
| Terminal UI | `extension/terminal.html`, `extension/src/terminal.ts`, UI styles |
| Chrome client and broker | `extension/src/client.ts`, `extension/src/worker.ts` |
| Shared TS protocol | `extension/src/protocol.ts` |
| Reusable protocol/framing | `crates/terminal-protocol` |
| Reusable PTY/session runtime | `crates/terminal-pty` |
| Host service, local agent bridge and installer | `crates/terminal-host` |
| MCP tools and transports | `mcp/` |
| ChatGPT plugin manifests and terminal skill | `plugin/` |
| Tests | `tests/`, crate unit/integration tests |
| CI / releases | `.github/workflows` |

## Documentation

- [Installation and troubleshooting](docs/INSTALL.md)
- [ChatGPT and MCP setup](docs/CHATGPT.md)
- [Build and release procedure](docs/RELEASING.md)
- [Architecture and lifecycle](docs/ARCHITECTURE.md)
- [Wire protocol](docs/PROTOCOL.md)
- [Permissions and trust model](docs/SECURITY.md)
- [Validation results and limits](docs/VALIDATION.md)

## License and upstream components

Host Terminal's original source is MIT licensed. Bundled dependencies retain their upstream licenses, including [xterm.js](https://github.com/xtermjs/xterm.js), [portable-pty](https://github.com/wezterm/wezterm/tree/main/pty), and their transitive dependencies. Keep the bundled notices when redistributing extension builds. Review platform and store packaging requirements before public distribution.
