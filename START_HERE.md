# Start Host Terminal

Download the [latest GitHub release](https://github.com/wieslawsoltes/HostTerminal/releases/latest). Choose the extension ZIP, one native companion ZIP, and the ChatGPT plugin ZIP if you want agent access. Every package includes a SHA-256 checksum; `SHA256SUMS` covers the full release and `RELEASE_MANIFEST.json` records the exact build commit.

## 1. Load the extension

1. Extract `host-terminal-extension-<version>.zip` to a folder you will keep.
2. Open `chrome://extensions` in desktop Google Chrome.
3. Enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
4. Verify the extension ID: `pcgpjpaehgkbjinhohohlpcbgfhmkilh` for the supplied build.

If you downloaded the complete source ZIP instead, load `host-terminal/dist/extension`. The `extension/` directory contains development sources and is not the built extension.

## 2. Install the native companion

Choose the archive for your computer:

| Computer | Native archive target |
| --- | --- |
| Linux x86-64, general use | `x86_64-unknown-linux-musl` (static binary) |
| Linux x86-64, Ubuntu 24.04-compatible glibc | `x86_64-unknown-linux-gnu` |
| Apple Silicon Mac | `aarch64-apple-darwin` |
| Intel Mac | `x86_64-apple-darwin` |
| Windows x86-64 | `x86_64-pc-windows-msvc` |

The full archive name is `host-terminal-native-<version>-<target>.zip`. Extract it, then open a terminal in the extracted directory.

### Linux and macOS

```sh
chmod +x ./host-terminal
./host-terminal install --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh --browser chrome
./host-terminal doctor --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh
```

### Windows PowerShell

```powershell
.\host-terminal.exe install --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh --browser chrome
.\host-terminal.exe doctor --extension-id pcgpjpaehgkbjinhohohlpcbgfhmkilh
```

Installation is per user and copies the companion to a stable location. No administrator shell, Node.js, Python, or Rust is needed for ordinary terminal use. The binaries are unsigned; follow your OS's normal review/approval flow or build from source if your policy requires it. Windows uses ConPTY and requires Windows 10 1809 or newer / Windows 11. Chrome on mobile is not supported.

## 3. Open a terminal

Click the extension toolbar button and choose **Connect to this computer**. The first terminal starts your default shell. Use **Shell profiles** for another executable, directory, argument list, or environment. Commands use the permissions of the OS user running Chrome.

**Alt+Shift+T** opens the terminal tab. **Alt+Shift+S** opens the side panel. Adjust conflicts in `chrome://extensions/shortcuts`. The command palette is **Ctrl+Shift+P** (**Cmd+Shift+P** on macOS).

Closing the page detaches its views while Chrome's native connection remains active. Close a session or choose **End all sessions** to stop its processes. Browser/extension/native-host restarts end managed sessions. Reattachment retains a bounded output tail; use `tmux` for durable jobs.

## 4. Connect ChatGPT

1. Install Node.js 22 or later and extract `host-terminal-chatgpt-plugin-<version>.zip`.
2. Follow the included plugin README to import it in a local desktop client or connect its stdio server through OpenAI Secure MCP Tunnel for ChatGPT on the web.
3. In Chrome, select the **plug icon → Enable ChatGPT access**.
4. Ask ChatGPT to list your Host Terminal sessions or run a command. New sessions appear in Chrome, and existing sessions are shared.

The plugin has full shell capabilities under your user account while enabled. **Disable ChatGPT access** revokes future requests and leaves your terminals open. Access defaults to off whenever the native companion restarts. See [the ChatGPT guide](docs/CHATGPT.md).

## Build or modify the source

Use Node.js 22+, Rust 1.89 or newer, and platform compiler tools:

```sh
npm ci
npm run build
npm run build:plugin
cargo build --release --locked -p terminal-host
```

Install `target/release/host-terminal` (`host-terminal.exe` on Windows) using the same commands above. Reload the extension in `chrome://extensions` after rebuilding. See [README.md](README.md), [installation troubleshooting](docs/INSTALL.md), [validation](docs/VALIDATION.md), and [release procedure](docs/RELEASING.md).
