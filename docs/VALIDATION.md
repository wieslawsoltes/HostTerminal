# Validation report — Host Terminal 0.2.0

Recorded 25 October 2026. Local results are listed below. The [GitHub Actions runs](https://github.com/wieslawsoltes/HostTerminal/actions) provide the authoritative status of platform CI; a release is published only after its complete validation matrix succeeds. Store review and platform signing are separate from these checks.

## Executed GitHub CI

The [successful baseline run 40230759359](https://github.com/wieslawsoltes/HostTerminal/actions/runs/40230759359) validated commit `7037eac160fcfbc1ca6585569f4f0eff2121307f` on 25 October 2026.

| Job | Executed result |
| --- | --- |
| Ubuntu 24.04 x86-64 | Rust formatting, Clippy, 25 workspace tests, six real installed-host tests and release build passed |
| macOS 15 Apple Silicon | Rust formatting, Clippy, 25 workspace tests, six real installed-host tests and release build passed |
| macOS 15 Intel | Rust formatting, Clippy, 25 workspace tests, six real installed-host tests and release build passed |
| Windows Server 2022 x86-64 | Rust formatting, Clippy, native/ConPTY tests and MSVC release build passed |
| Extension and ChatGPT plugin | Strict TypeScript, 17 extension tests, 15 MCP tests against source and bundle, reproducible checked-in plugin, package validation and 14 release tests passed |
| Chromium integration | Actual extension, installed native companion, PTYs and packaged MCP shared-session/revocation test passed |

This run exposed and verified fixes for Darwin saturated-PTY shutdown and Winsock stale-connection probe timing. The release workflow reruns the complete matrix on the release commit, then tests every exact shipping target, including static musl. The release manifest records that commit and every artifact hash.

## Environment

- Linux x86-64, Ubuntu 24.04 userspace.
- Rust 1.89.0 (declared minimum) and 1.99.1; bridge, workspace tests, formatting and Clippy verified with 1.89.0.
- Node.js 24.22.1; project requires Node.js 22 or later.
- Chromium 141.0.7390.37, launched through Playwright 1.56.1 with an isolated user-data directory and the real unpacked extension.
- xterm.js 6.0.0 and exact addon versions from `package-lock.json`.

## Executed checks

| Check | Result |
| --- | --- |
| TypeScript strict typecheck | Passed |
| Protocol/broker JavaScript tests | 17 passed |
| MCP SDK, tools, stdio and HTTP integration | 15 passed |
| Release packaging/publication invariant tests | 14 passed |
| Rust workspace tests on Linux | 25 passed: 5 protocol, 7 PTY/flow/cancellation, 8 host/bridge, 5 installer |
| Rust formatting and Clippy, warnings denied | Passed |
| Real installed-native-host process integration | 6 passed against the 0.2.0 installed Linux native host; also run on POSIX CI |
| Windows x86-64 target, all-target workspace `cargo check` | Passed |
| Apple Silicon macOS target, all-target workspace `cargo check` | Passed |
| Extension production build and ZIP packaging | Passed |
| Chromium → service worker → installed native host → real PTY | Passed against the 0.2.0 Linux native host and packaged MCP server |
| Responsive UI geometry | Checked at 360, 390, 600, 800, 810, and 1440 pixels; no toolbar overlap |

## Native process integration

The Python test installs the actual executable into a temporary directory, including paths with spaces and non-ASCII characters. It does not change the user's normal Chrome registration. It exercises:

1. Installer/doctor, manifest contents, and refusal of an unauthorized origin before any protocol output.
2. Split native-message headers/payloads, Unicode JSON, capability handshake, invalid dimensions, and unsupported requests.
3. A real `/bin/sh` PTY with input, Unicode, `stty size`, terminal resize to 113×37, ANSI bytes, final output, and exit code 7.
4. Saturation of the 256 KiB output window, rejection of an acknowledgement beyond sent output, recovery after valid acknowledgement, and session close while output is saturated.
5. Native stdin EOF terminating and reaping the managed shell/foreground process.
6. Independent simultaneous sessions, rename, explicit shutdown, and child cleanup.

Additional Rust tests cover byte preservation and bounded cleanup when a slave descriptor stays open or stops reading. A Windows-only ConPTY lifecycle test is included for execution on a Windows CI runner.

## Browser integration

The test loads the real built extension and registers the real companion in the isolated browser profile. It verifies:

- The extension's stable ID and first connection.
- Actual shell command output, Unicode (including an emoji), ANSI color, and native PTY sizing.
- Multiple sessions and side-by-side layout.
- Rename, search with nonzero match counts, settings persistence, and theme changes.
- Page reload followed by reattachment to existing shells, including their retained output.
- A compact 390-pixel viewport with no toolbar overlap or page overflow.
- More than 256 KiB of terminal output (60,000 lines) completing through actual xterm parse-completion acknowledgements.
- Ctrl+C interrupting a real sleeping process, followed by another successful command.
- Multiline paste interception, review, acceptance, and eventual execution.
- Explicit companion shutdown and no browser JavaScript errors.

The browser suite waits for observable shell output before sending an interrupt or subsequent command; a command accepted by an input queue is not equivalent to a shell-ready prompt.

## ChatGPT bridge and MCP checks

The actual browser integration now also verifies the packaged Node server through an official MCP SDK stdio client against the same native process:

- Calls fail before the user enables ChatGPT access.
- The extension enables access and displays only a discovery path, never its token.
- MCP lists the Chrome-created shells and writes a command into an existing shell.
- Chrome and MCP read the same real PTY output.
- `terminal_run` creates a new session, returns final output/exit status, and the session automatically appears in Chrome.
- Agent rename updates the UI; agent close removes the native session.
- Disabling access blocks further MCP calls while the existing Chrome terminal continues working.

Rust bridge tests exercise actual authenticated loopback framing, denied control requests, token rotation, private descriptor permissions, stale-descriptor recovery, exclusion of a second active owner, cancellation of queued calls, and bounded binary output cursors. MCP integration tests exercise all ten tools, fragmented frames, no mutation retry after an uncertain disconnect, bounded waits/output, started-session recovery details, invalid input, and local HTTP authentication/Origin/Host/body limits. Release tests reject incomplete or tampered assets, version drift, wrong binary architecture, mutable tags and overwrites of published releases.

## Linux binary

The static release target is `x86_64-unknown-linux-musl`. Its release executable is inspected as ELF x86-64 and included in its own native ZIP. GNU/Linux has a separate archive built on Ubuntu 24.04. Exact package sizes and hashes are recorded in the release manifest.

## Boundaries of the evidence

- Local cross-checks cover macOS and Windows compilation. The GitHub CI matrix runs native tests on Windows x64, macOS Apple Silicon, macOS Intel, and Linux. Review the linked run for the specific commit; this document does not substitute for its result.
- The browser suite tests Chromium on Linux. Chrome's side panel uses the same workspace; its compact layout is tested, while a separate platform-specific side-panel interaction suite is not claimed.
- Browser restart, extension reload, or native-host exit ends its managed sessions. Page reattachment replays bounded recent raw bytes, not an exact screen-state snapshot or durable session history.
- An intentionally detached process, remote SSH session, or independently managed `tmux` server follows normal OS/tool lifecycle rules. The host does not claim to kill every descendant daemon.
- The package is for unpacked installation. It has not been published to a store, signed/notarized for public platform distribution, or independently audited.

## Reproduce

```sh
npm ci
npm run typecheck
npm test
npm run test:mcp
npm run build
npm run build:plugin
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --locked -p terminal-host
python3 tests/native_smoke.py
npx playwright install chromium
npm run test:browser
npm run package
```

For a static Linux build:

```sh
rustup target add x86_64-unknown-linux-musl
cargo build --release --locked --target x86_64-unknown-linux-musl -p terminal-host
HOST_TERMINAL_BINARY="$PWD/target/x86_64-unknown-linux-musl/release/host-terminal" python3 tests/native_smoke.py
HOST_TERMINAL_BINARY="$PWD/target/x86_64-unknown-linux-musl/release/host-terminal" npm run test:browser
```
