# Host Terminal for ChatGPT and Codex

This plugin gives an MCP client access to the real PTY sessions shared with the **Host Terminal** Chrome extension. Agent-created sessions appear in Chrome, and the agent can work with sessions you opened there. The native host runs processes with your desktop account's privileges.

## Prerequisites

1. Install the Chrome extension and the matching native host from the [Host Terminal releases](https://github.com/wieslawsoltes/HostTerminal/releases). Follow the [installation guide](https://github.com/wieslawsoltes/HostTerminal/blob/main/docs/INSTALL.md).
2. Install **Node.js 22 or later**. The release plugin includes its MCP dependencies in `server/index.mjs`; no `npm install` is needed for the plugin ZIP.
3. Open Host Terminal in Chrome and connect the native host. Select the **ChatGPT access** plug icon in the toolbar, then enable access in its dialog. Access starts disabled whenever the native host restarts.
4. Extract the ChatGPT plugin ZIP to a stable folder on the same computer. Keep Chrome and the Host Terminal connection running while using the plugin.

Disabling ChatGPT access revokes the local bridge without closing your terminal sessions. Closing or restarting the Chrome native connection ends that host and its sessions. Installing the plugin alone does not grant terminal access.

## Local ChatGPT desktop or Codex

Install this folder using your client's local plugin or repository marketplace workflow. Its portable `plugin.json` and `mcp.json` declare the bundled stdio MCP server and `terminal-control` skill. A `.codex-plugin/plugin.json` compatibility manifest is also included. The package is intended for local desktop execution.

The repository includes a **Host Terminal** marketplace and a ready-to-run bundled server. Where the Codex marketplace CLI is available, register it with:

```sh
codex plugin marketplace add wieslawsoltes/HostTerminal --ref main
```

Open the ChatGPT desktop app, restart it if needed, choose **Host Terminal** as the marketplace source in the Plugins Directory, and install the plugin. For a local checkout, `codex plugin marketplace add /absolute/path/to/HostTerminal` registers that repository. Its `.agents/plugins/marketplace.json` points to `./plugin` relative to the repository root. No build or dependency installation is required for the checked-in release server.

For a client that accepts a direct stdio MCP configuration, use an **absolute path** to the extracted server:

```json
{
  "mcpServers": {
    "host_terminal": {
      "command": "node",
      "args": ["/absolute/path/host-terminal-plugin/server/index.mjs"]
    }
  }
}
```

On Windows, use a JSON-escaped path such as `C:\\Tools\\HostTerminalPlugin\\server\\index.mjs`. In the bundled plugin manifest, `${PLUGIN_ROOT}` is resolved by the plugin runtime; it is not an environment variable you need to set for direct MCP configuration.

Ask the connected client to call `host_status`, then `terminal_list`. A successful call reports the actual native host platform and the same sessions visible in Chrome. Run a harmless command such as `printf 'Host Terminal connected\n'` on a POSIX shell or `Write-Output 'Host Terminal connected'` in PowerShell to verify execution.

See OpenAI's [plugin packaging](https://developers.openai.com/plugins/build/plugins) and [desktop-only plugin](https://developers.openai.com/plugins/deploy/desktop-only) documentation for client installation availability. Publishing these artifacts on GitHub does not publish them to the OpenAI Plugin Directory; local MCP directory submissions require OpenAI eligibility and review.

## ChatGPT through a Secure MCP Tunnel

OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) can forward a ChatGPT connection to this local **stdio** server. This route does not require an HTTP listener for Host Terminal.

Create a tunnel in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), associate the intended ChatGPT workspace, and obtain a runtime key with the required tunnel permissions. Download the supported [tunnel-client](https://github.com/openai/tunnel-client/releases/latest). Supply `CONTROL_PLANE_API_KEY` privately in the local process environment; do not put its literal value in command arguments, repository files or chat.

Run the following on the computer where Chrome and Host Terminal are running, replacing the tunnel ID and server path:

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile host-terminal \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-command "node /absolute/path/host-terminal-plugin/server/index.mjs"

tunnel-client doctor --profile host-terminal --explain
tunnel-client run --profile host-terminal
```

If the path contains spaces, quote it according to the `tunnel-client` command parser and your shell. Run `tunnel-client help quickstart` for the installed version's supported configuration.

Keep the tunnel client running. In [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add custom MCP server**, select **Tunnel** for the connection, and select the same tunnel. Complete the connection's authentication and consent steps, create the plugin, then call `host_status` in ChatGPT. Workspace permissions and tunnel access must allow this connection. Configuration is complete only after that actual tool call succeeds.

## Optional local HTTP transport

For MCP clients that need Streamable HTTP, create a separate random bearer token and start the loopback listener:

```sh
node server/index.mjs --init-token /private/path/host-terminal-mcp-token
node server/index.mjs --http --token-file /private/path/host-terminal-mcp-token
```

Use `http://127.0.0.1:8767/mcp` with an `Authorization: Bearer ...` header supplied privately by the client. The token file is created exclusively and never overwritten or printed. On Unix it must be owned by your user with mode `0600`, within a directory other users cannot modify. On Windows, keep it in a user-private directory whose NTFS permissions exclude other accounts. You can alternatively supply `HOST_TERMINAL_MCP_TOKEN_FILE` or `HOST_TERMINAL_MCP_TOKEN` in the server environment.

`--port` changes the port, and `--port 0` chooses an available one. HTTP always binds to `127.0.0.1`. Host headers must name this listener; browser origins are denied unless they match the listener or an explicitly supplied `--allowed-origin https://exact.example` value. No-Origin native clients are accepted with a valid bearer token. Wildcard origins and public bind addresses are unsupported. The server does not configure a tunnel or start a public endpoint.

## Tools

| Tool | Purpose |
| --- | --- |
| `host_status` | Read native host information, shell profiles and limits. |
| `terminal_list` | List sessions shared with Chrome. |
| `terminal_create` | Start a session with a shell, arguments, directory, environment and terminal size. |
| `terminal_read` | Read output by byte cursor; optionally wait up to ten seconds for output or exit. |
| `terminal_write` | Send text or exact base64 bytes; optionally append an Enter key. |
| `terminal_interrupt` | Send Ctrl+C; the process may interpret or ignore it. |
| `terminal_resize` | Change the PTY size shared with Chrome. |
| `terminal_rename` | Change the title shown in Chrome. |
| `terminal_close` | Terminate and remove a session, discarding retained output. |
| `terminal_run` | Execute a command once in a new session, returning bounded output and the session ID. |

Every successful tool result has `structuredContent: { "ok": true, "data": { ... } }`. Failures return `isError: true` with an error code, message and `uncertainState` flag. The text content contains the same JSON for clients without structured-result rendering.

### Output and recovery

Reads and writes are limited to 64 KiB per call. Output is retained in the native host's bounded one-MiB history per session. Save each returned `cursor` and pass it to the next read. Cursors count raw bytes and are independent of Chrome's flow-control acknowledgements. A `truncated` result reports a history gap. `data` is exact base64; `text` is a best-effort UTF-8 rendering that may replace a character split between reads.

`terminal_run` waits for at most ten seconds of output collection. Reaching its wait or output limit leaves the process and session available. Continue with `terminal_read`; use `exited` and `exitCode` to determine completion. Native connection setup and command dispatch also have bounded transport deadlines.

Mutations are never automatically retried. If `uncertainState` is true, inspect sessions before issuing another command. If an output read fails after `terminal_run` started the process, error details include `commandStarted`, the session ID and cursor so the client can resume without rerunning it. Session closure removes the output history for both Chrome and the agent.

## Bridge discovery and troubleshooting

The plugin reads a private `agent-bridge.json` generated by the Chrome native host:

| Platform | Default location |
| --- | --- |
| Linux | `$XDG_DATA_HOME/host-terminal/agent-bridge.json`, or `~/.local/share/host-terminal/agent-bridge.json` |
| macOS | `~/Library/Application Support/Host Terminal/agent-bridge.json` |
| Windows | `%LOCALAPPDATA%\HostTerminal\agent-bridge.json` |

Set `HOST_TERMINAL_BRIDGE_FILE` or pass `--bridge-file PATH` for a custom native installation. The descriptor contains a bearer credential: keep it private and do not paste it into chat or commit it. Bridge access uses a fresh authenticated loopback connection per operation; the plugin never starts an independent terminal host.

For `bridge_disabled`, open the Chrome extension, connect the native host, and enable ChatGPT access. For `bridge_unavailable`, recheck the Chrome connection and re-enable access. For `insecure_credentials`, restore user-only file permissions and a directory other users cannot modify. Do not make credential files broadly readable to work around the check.

## Build and verify from source

From the repository root:

```sh
npm ci
npm run build:plugin
node --test tests/mcp.test.mjs
npm run package:plugin
```

The build bundles the pinned MCP SDK and schema validator into `server/index.mjs`, including dependency license notices. The release ZIP contains this directory's manifests, server, skill, instructions and license files. GitHub releases distribute the package; you select and authorize its installation on each host.
