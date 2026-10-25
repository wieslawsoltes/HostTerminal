# Permissions and trust model

Host Terminal is an intentional local terminal. The shell has the rights of the OS account running Chrome: it can read/write files, run installed programs, connect to networks, and modify that account's environment in exactly the ways a normal terminal can. The extension provides no automatic privilege elevation. Commands such as `sudo` remain subject to the operating system's ordinary authentication and policy.

## Trust boundary

The native companion is installed explicitly and authorizes exact extension IDs. Chrome checks the host manifest's `allowed_origins`; the host checks the calling origin again against its adjacent `host-config.json` before creating PTYs. A missing config or unmatched origin fails closed.

The extension bundles all executable JS and uses a restrictive extension-page Content Security Policy. It declares no content scripts, page host permissions, `externally_connectable`, or web-accessible control API. A visited website cannot ask the worker to run a command. The worker also verifies that a connecting view is one of its own terminal pages before accepting requests.

Chrome communicates through its process pipe to the installed native host. ChatGPT access is off at every host startup. Enabling it explicitly opens an ephemeral TCP listener bound only to `127.0.0.1`, with a random 256-bit token in a user-private discovery file. Every request is authenticated; the listener is not an HTTP or WebSocket server. Disabling access revokes the token and removes discovery without closing the terminal sessions. The extension's public manifest key is an identifier-stability mechanism; it does not constitute a security secret or grant websites process access.

The same OS user can already execute programs and edit their own native-host configuration. This project does not attempt to isolate the terminal from that user's other processes or protect a compromised account. Protect and review any extension build authorized to use this host; code running inside that authorized extension is within the terminal's trust boundary.

## ChatGPT and MCP access

The local plugin reads the bridge discovery file from the native installation directory. It does not create a second native host or hidden parallel shell service. Its tools operate on the exact SessionManager used by the extension. A process able to read the same user's private discovery file is within this trust boundary.

The bridge only allows terminal operations and metadata/output reads. It cannot enable itself, disable itself, acknowledge Chrome output, or shut down the native host. The host applies constant-time token comparison, message/connection/output limits, deadlines, and cancellation checks before executing queued requests. An exclusive OS lock prevents another native instance from replacing a live bridge's discovery file. Tokens are absent from UI status, plugin tool output and logs.

The optional MCP HTTP server binds to loopback, requires a separate bearer token from a private token file, and rejects unexpected Host/Origin values. The default plugin uses stdio. A Secure MCP Tunnel is an optional outbound connection the user configures in their OpenAI account. When a ChatGPT conversation calls a tool, that tool's returned terminal output becomes part of the conversation; terminal contents are not automatically uploaded by this extension.

MCP execution tools accurately advertise their ability to change files, execute commands and access the network. The included skill treats terminal output as untrusted data, preserves byte cursors, and forbids automatically retrying a mutation after an uncertain transport result. These controls do not restrict the legitimate capabilities of an OS shell. Use the extension's **Disable ChatGPT access** control to revoke subsequent requests. A command already accepted by the shell continues until interrupted or closed.

## Extension permissions

| Permission | Purpose |
| --- | --- |
| `nativeMessaging` | Connect to the installed PTY companion |
| `storage` | Save settings and shell profiles locally |
| `sidePanel` | Show the terminal workspace in Chrome's side panel |
| `clipboardRead` | User-requested clipboard paste |
| `clipboardWrite` | User-requested copying of terminal selections and the extension ID |

Clipboard access is used by terminal UI actions. Terminal output does not automatically write to the system clipboard: OSC 52 is blocked. Links originating from terminal output are treated as untrusted and opened only through a user action with allowed web schemes. Terminal titles and other process-provided strings must be rendered as text.

Multiline paste is reviewed in the UI because pasted newlines can immediately execute shell input. This is a convenience against accidental commands; it is not a command sandbox. The native companion intentionally does not attempt to classify or restrict what a user can type into their own shell.

## Resource controls

Protocol lengths are checked before allocation, input payloads have explicit bounds, and output is transported as lossless bytes. At most 16 PTY sessions exist per host connection. Per-session byte credits and a bounded stdout queue apply backpressure when the renderer falls behind. The broker retains only bounded replay history while detached. The agent output ring separately retains at most 1 MiB per session; each read returns at most 64 KiB and reports truncation. Agent reads do not consume or acknowledge the Chrome stream.

The installer serializes concurrent operations, rejects malformed IDs and origin strings, refuses unrelated native manifests, and uses atomic same-directory file replacement. Unix executable/configuration permissions are scoped to the user. Windows registration uses HKCU and Unicode-safe registry APIs; it does not modify machine-wide keys.

## Data retention

Settings and profiles remain in the extension's local storage. Profiles may contain user-entered environment values; do not store secrets there if you do not want them retained in browser profile data. Terminal scrollback and detached replay are transient memory. Exporting a transcript creates a user-requested file that may contain secrets printed by commands. The project has no telemetry or cloud transcript service.

Shells and their programs retain their own normal state: shell history, SSH known-hosts, editor swap files, build artifacts, and application logs are controlled by those programs, not by the extension's transient scrollback policy.

## Distribution

Unpacked loading is intended for development/private distribution. Public distribution should review Chrome Web Store policies, use signed/notarized platform packages where appropriate, preserve upstream licenses, and audit the native/extension dependency locks. The release workflow verifies all artifacts in a draft before publishing; it does not claim store approval, platform signing, or an independent security audit.

## Sources

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome extension security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)
- [xterm.js security guidance](https://xtermjs.org/docs/guides/security/)

- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Model Context Protocol security practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices)
