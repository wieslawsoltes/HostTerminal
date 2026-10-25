# Installation, updates, and troubleshooting

## What gets installed

Host Terminal has two independent components:

1. A Chrome extension containing the UI, xterm.js, and the service-worker broker.
2. A native Rust executable that Chrome launches on demand to create real OS pseudoterminals.

The companion is not a background service. It opens no network listener. Chrome communicates with it through anonymous standard-input/output pipes using [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

## Build prerequisites

- Desktop Chrome with extension Developer mode available.
- Node.js 22+ and npm for building the extension.
- Stable Rust with Cargo.
- A C/C++ toolchain supported by Rust's native dependencies: Xcode command-line tools on macOS, a normal C toolchain on Linux, or Visual Studio Build Tools with C++ and Windows SDK on Windows.

Run `npm ci`, `npm run build`, and `cargo build --release --locked` in the project directory. A recipient of already-built extension/native packages does not need Node.js or Rust at runtime.

## Load the extension

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `dist/extension`. Select the actual directory containing `manifest.json`, not the source `extension` directory or a ZIP file.

The supplied manifest key stabilizes the unpacked extension ID at:

```text
pcgpjpaehgkbjinhohohlpcbgfhmkilh
```

Check the actual ID displayed by Chrome and use it in the install command. A different manifest key or Chrome Web Store signing identity can produce a different ID. The public key in source is not a secret, and it is not a packaged-extension private signing key.

## Register the native companion

### Linux and macOS

```sh
./target/release/host-terminal install \
  --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh \
  --browser chrome
./target/release/host-terminal doctor \
  --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh
```

For a downloaded native release, the executable is `./host-terminal`. If the extractor did not retain its executable bit, use `chmod +x ./host-terminal`. On macOS, an unsigned downloaded executable may require approval in System Settings after you inspect/trust its provenance. Public distribution should add Developer ID signing and notarization; the project does not claim to provide signed binaries.

### Windows PowerShell

The published Windows MSVC binary requires the [Microsoft Visual C++ v14 Redistributable for x64](https://aka.ms/vc14/vc_redist.x64.exe). Install it if it is not already present, especially if Windows reports a missing `VCRUNTIME140.dll`. Use the current package linked from [Microsoft's supported downloads](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist).

```powershell
.\target\release\host-terminal.exe install `
  --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh `
  --browser chrome
.\target\release\host-terminal.exe doctor `
  --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh
```

The executable uses the current user's registry hive. Administrator mode is unnecessary. Windows 10 version 1809 or newer is needed for ConPTY. Current Windows 11 is the preferred Windows target. Use installed PowerShell, Command Prompt, Git Bash, or another available shell through a shell profile. WSL can be launched as a profile whose executable is `wsl.exe`; environment/path semantics inside WSL are those of the selected Linux distribution.

## Locations

| Item | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Companion | `$XDG_DATA_HOME/host-terminal/host-terminal`, otherwise `~/.local/share/host-terminal/host-terminal` | `~/Library/Application Support/Host Terminal/host-terminal` | `%LOCALAPPDATA%\HostTerminal\host-terminal.exe` |
| Host authorization | `host-config.json` adjacent to executable | Same | Same |
| Chrome registration | `$XDG_CONFIG_HOME/google-chrome/NativeMessagingHosts/com.host_terminal.host.json`, otherwise `~/.config/...` | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.host_terminal.host.json` | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.host_terminal.host` points to the installed manifest |

The installer writes configuration and executable files atomically, serializes concurrent installer operations with a lock, and refuses to replace a manifest whose host name/path identify another installation. Unix installation directories are private to the current user. Configuration files are readable/writable by that user.

### Other Chromium browsers

Pass `--browser chromium`, `--browser edge`, `--browser brave`, or `--browser chrome-for-testing`. Linux/macOS use the corresponding browser's default user-data directory. On Windows, Chromium and Edge have their own registry keys; Chrome, Brave's Chrome compatibility path, and Chrome for Testing share the Chrome registration. Removing that shared registration affects all three. Native host lookup can also be affected by distribution packaging and administrator policy.

For Chrome Beta/Dev, a custom profile directory, or a browser installed with a nonstandard user-data directory, supply the precise directory:

```sh
./target/release/host-terminal install \
  --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh \
  --manifest-dir "/absolute/path/to/chrome-user-data/NativeMessagingHosts"
```

On Linux/macOS, the parent is Chrome's **user data directory**, not its `Default` or `Profile 1` subdirectory. Match the actual `--user-data-dir` used when starting that browser. The same override must be supplied to `doctor` and `uninstall`. On Windows, `--manifest-dir` chooses the manifest's file location; the installer still registers its path under HKCU.

`--install-dir /absolute/path` selects a different companion directory. Use the same directory for later operations. It is useful for isolated development/tests; it is not needed for normal installation.

## Connect and choose a shell

Open the extension and select **Connect**. The handshake reports the host OS, architecture, home directory, default shell, detected shells, and configured limits. The first session uses the host's default shell unless you select a profile.

Profiles specify the executable separately from its JSON argument array. For example, `/bin/bash` with `["-l"]` runs a login shell. A custom command such as Python uses `python3` with `["-i"]`. The companion passes arguments directly to the OS process API; it does not interpolate the executable/argument fields into a shell command. Environment overrides apply to the child process. An empty working directory means the host home directory.

Shell startup files can change environment variables, output banners, or replace the shell. The terminal displays their output. SSH, sudo, compilers, and file operations run with the same behavior and permissions as a normal local terminal. The extension itself does not elevate privileges.

## Updating

1. Finish work and close terminal sessions. Exit Chrome if you are replacing an in-use Windows executable.
2. Build/download the new extension and native companion.
3. Run the new binary's `install` command with your extension ID and previous options.
4. Reload the extension in `chrome://extensions`, then reconnect.

Repeating `install` adds the supplied ID while retaining existing browser registrations. To authorize a second unpacked/store extension ID, run it again with that ID. Do not use wildcards in native host manifests.

## Uninstall or revoke access

Remove one extension's authorization for the selected browser:

```sh
./target/release/host-terminal uninstall \
  --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh \
  --browser chrome
```

Remove the whole selected browser registration:

```sh
./target/release/host-terminal uninstall --browser chrome
```

Existing native sessions are not retroactively disconnected by editing configuration. End sessions from the UI, quit Chrome, or reload/remove the extension in `chrome://extensions` to terminate its native connection. Closing just the terminal page detaches its sessions and keeps the native connection alive. The uninstall command removes the registration and recomputes allowed origins from remaining registrations. It retains the native executable/configuration so that the uninstaller can complete while running on Windows. After all registrations are removed and browsers are closed, delete the printed install directory if you want to remove those remaining files. Remove the extension in `chrome://extensions` to remove its local settings.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| **Specified native messaging host not found** | Run `doctor` with the same browser/path overrides. Check that the browser is using the user-data directory into which the manifest was installed. |
| **Access to the specified native messaging host is forbidden** | Compare the ID in `chrome://extensions` with the manifest's `allowed_origins` and `host-config.json`. Run install for the actual ID. |
| **Failed to start native messaging host** | Check the executable exists, its architecture matches the OS, Unix execute permission is set, and platform security permits launching it. |
| **Native host has exited** | Inspect Chrome's extension/service-worker error log and host stderr diagnostics. A missing/malformed adjacent config or an unauthorized origin is rejected before shell creation. |
| **Error when communicating with the native messaging host** | Use the compiled executable directly as the manifest path. A shell wrapper that writes text to stdout corrupts Native Messaging frames. |
| Windows reports missing `VCRUNTIME140.dll` | Install Microsoft's current x64 Visual C++ v14 Redistributable, then rerun the companion. |
| Installer cannot replace Windows binary | End sessions and exit Chrome so the companion is no longer running, then rerun install. |
| Installer reports `.install-lock` | Another install/uninstall is active. If one was forcibly killed, confirm none is running before deleting only that stale lock. |
| Shell executable not found | Use a valid absolute executable path, or fix the host user's `PATH`. GUI-launched Chrome may inherit a different environment from a login terminal. |
| Program waits despite no visible output | A hidden/stalled view can apply output backpressure. Focus or reconnect the terminal; ending the session releases its resources. |
| Reattached full-screen application looks wrong | Replay is bounded byte history, not an exact snapshot. Resize/redraw the application, or detach/reattach its `tmux` session. |
| Works in normal Chrome, not packaged Flatpak/Snap | The browser sandbox may prevent it from launching arbitrary host executables. Use a package with native-host support or configure the distributor's supported integration. |
| Managed browser forbids native messaging | Consult the administrator's NativeMessaging policies. The installer does not bypass enterprise controls. |

`doctor` checks installation files, authorization consistency, executable permissions on Unix, and the registry on Windows. It cannot certify browser policy, a running extension, or an interactive shell; the extension's live handshake/session creation checks those paths.

## Reference material

- [Chrome Native Messaging and registration locations](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Microsoft Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)
- [Chromium native host Windows lookup implementation](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/launch_context_win.cc)
- [Microsoft pseudoconsole documentation](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)
