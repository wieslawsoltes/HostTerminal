# ChatGPT and MCP integration

The Host Terminal plugin gives ChatGPT access to the same real terminal sessions displayed in the Chrome extension. It includes ten MCP tools, a bundled Node.js server, portable and Codex-compatible plugin manifests, and a terminal-control skill.

## Prerequisites

Install the extension and native companion from the [GitHub release](https://github.com/wieslawsoltes/HostTerminal/releases/latest), connect to the companion in Chrome, and install Node.js 22 or later on that computer. Extract `host-terminal-chatgpt-plugin-<version>.zip` into a stable directory.

In Chrome, select the plug icon and **Enable ChatGPT access**. Access is off whenever the native host starts. The plugin cannot enable it by itself. You can revoke it in the same dialog without ending your existing terminals.

## Desktop plugin

Import the extracted plugin using the local-plugin flow supported by your desktop client. The archive contains `plugin.json`/`mcp.json` and `.codex-plugin/plugin.json`/`.mcp.json`. Its stdio command is `node ${PLUGIN_ROOT}/server/index.mjs`. The compiled server contains its dependencies, so you do not need to run npm in the extracted plugin.

Local MCP execution requires the client to run on the computer with Chrome. This is distinct from adding an HTTP server URL to a cloud-only client. See the [plugin README](../plugin/README.md) for client configuration and custom installation paths.

For a client that accepts a generic MCP server configuration:

```json
{
  "mcpServers": {
    "host_terminal": {
      "command": "node",
      "args": ["/absolute/path/to/extracted-plugin/server/index.mjs"]
    }
  }
}
```

Use an absolute path on your computer. On Windows, JSON paths use escaped backslashes or forward slashes. If the host was installed into a custom directory, add `HOST_TERMINAL_BRIDGE_FILE` in the server's environment with the discovery file path shown by Chrome's ChatGPT access dialog.

## ChatGPT on the web through Secure MCP Tunnel

OpenAI's Secure MCP Tunnel can launch a local stdio MCP server and forward requests through an outbound connection. You need a tunnel in the intended Platform organization, association with the intended ChatGPT workspace, and the corresponding tunnel permissions. No public listener or router port forwarding is needed.

Follow the current [official tunnel setup guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and install `tunnel-client` from its linked release. Provide the runtime API key locally through the documented environment/credential mechanism; do not paste it into this repository, terminal transcripts, or chat.

For a new named profile, adapt the official stdio example:

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile host-terminal \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-command "node /absolute/path/to/extracted-plugin/server/index.mjs"

tunnel-client doctor --profile host-terminal --explain
tunnel-client run --profile host-terminal
```

Keep that client running on the computer with Chrome. In ChatGPT, open **Plugins → + → Add custom MCP server**, choose **Tunnel**, select the tunnel, and follow the account's authentication and permission prompts. Select the resulting plugin in a conversation and ask it to call `host_status` and `terminal_list` first.

The tunnel and ChatGPT account configuration are separate from downloading this project. The GitHub release does not create a tunnel, supply an OpenAI API key, install a plugin into your account, or submit a public Plugin Directory listing.

## Tools and session behavior

| Tool | Purpose |
| --- | --- |
| `host_status` | Connection status, host version, platform, shells and limits |
| `terminal_list` | Current shared sessions and process metadata |
| `terminal_create` | Start an interactive PTY with executable/args/cwd/env |
| `terminal_run` | Run a command in a new PTY and return bounded output plus session ID |
| `terminal_read` | Read at most 64 KiB with a byte cursor; optionally wait up to 10 seconds |
| `terminal_write` | Send text or raw base64 input, optionally with Enter |
| `terminal_interrupt` | Send Ctrl+C to the terminal |
| `terminal_resize` | Resize the PTY; a later Chrome pane resize can supersede this |
| `terminal_rename` | Update the shared session title |
| `terminal_close` | Terminate/remove the session and discard its output history |

Output is retained in a bounded 1 MiB ring per session. Keep each returned cursor for the next read; `truncated` reports older bytes evicted. `data` is exact base64 and `text` is best-effort UTF-8. A tool wait deadline leaves the process running and preserves its session ID. An uncertain mutation result must be inspected before retrying because a command may already have reached the shell.

ChatGPT-created sessions appear in Chrome, where you can observe, type into, interrupt, rename or close them. A human and an agent can send input to the same shell, so coordinate interactive edits and password prompts. Normal terminal output is untrusted process data. Returned tool output is sent to the calling ChatGPT conversation; the extension itself has no telemetry or cloud transcript service.

## Optional HTTP transport

The bundled server also supports authenticated Streamable HTTP bound to localhost. It requires a separate private bearer-token file, validates Host/Origin and rejects unauthenticated calls. Use it only when your MCP client needs HTTP; stdio is the simplest local/tunnel setup. See [plugin/README.md](../plugin/README.md) for exact CLI options and authentication configuration.

## Validation and references

The browser integration test starts the packaged MCP server and real extension against one installed native host, verifies disabled-by-default access, runs commands in a Chrome-created shell, reads the same output, creates an agent session visible in Chrome, and checks revocation. MCP tests also exercise protocol framing, tool semantics and HTTP authentication. See [VALIDATION.md](VALIDATION.md) and [GitHub Actions](https://github.com/wieslawsoltes/HostTerminal/actions) for executed results.

- [OpenAI local MCP / desktop plugins](https://developers.openai.com/plugins/deploy/desktop-only)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI custom MCP servers](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
