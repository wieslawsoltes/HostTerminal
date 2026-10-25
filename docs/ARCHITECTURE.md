# Architecture and lifecycle

## Components

| Component | Responsibility | Lifetime |
| --- | --- | --- |
| `terminal.html` / xterm.js | Render terminal escape sequences; collect keyboard input; manage visible panes, profiles, search, and local settings | One extension page or side panel |
| `HostClient` | Request correlation, view connection, typed event delivery, acknowledgements | One terminal page |
| MV3 service worker / `SessionBroker` | Own the native port, route session events, enforce one interactive view per session, and retain bounded replay | Chrome-managed worker held alive by the native connection |
| `terminal-protocol` | JSON types, field validation, limits, and length-prefixed framing | Reusable library |
| `terminal-pty` | OS PTY creation, input, resize, output credit, shell discovery, and process cleanup | Reusable library / sessions |
| `terminal-host` | Validate the calling extension origin, run the protocol dispatcher, and expose installer/diagnostics | One native messaging process |
| Native agent bridge | Authenticate optional local MCP requests and retain bounded output cursors | Explicitly enabled for one native host lifetime |
| Node MCP server | Expose terminal tools over stdio or authenticated local HTTP | Local plugin process or user-started HTTP server |
| Child shell / application | Execute the user's commands with their normal OS access | One PTY session |

All terminal resources are bundled with the extension. There is no downloaded runtime JavaScript, content script, site injection, or arbitrary website-to-host API. The optional agent bridge is separate from the extension pipe and disabled until the user enables it. The service worker accepts only its own terminal pages, and the host separately validates the exact extension origin against its installed authorization file.

## Why Native Messaging

Chrome cannot expose a general-purpose host shell directly to extension JavaScript. Its supported mechanism is an explicitly installed native application, launched through `chrome.runtime.connectNative`. That API gives the extension a persistent port to a process whose stdin/stdout are dedicated to framed messages. Chrome controls host discovery and applies the host manifest's origin allowlist. Host Terminal also validates the origin in Rust before creating the session manager.

The extension itself requires no localhost service discovery or network listener. It is intentionally desktop-local: Chrome and the native companion execute on the same computer.

## Connection sequence

1. The user opens the terminal and chooses **Connect**.
2. The page connects to the extension's worker; the worker checks the sender identity.
3. The worker opens `com.host_terminal.host` with `connectNative`.
4. Chrome finds its registered manifest and starts the installed executable, passing the extension origin as the first argument.
5. The executable loads `host-config.json` adjacent to itself, validates the caller, and starts the protocol dispatcher.
6. `hello` negotiates protocol version 1 and returns shell/system metadata. The worker rejects a mismatched protocol.
7. The UI lists available sessions and attaches, or explicitly creates a session. The host opens a real PTY and spawns the requested executable/arguments directly.

The installer and Native Messaging entrypoint share a binary. Native execution never prints diagnostics to stdout: that stream contains only valid protocol frames. Human-readable installation/help messages are used only by CLI subcommands.

## Shared ChatGPT sessions

Selecting **Enable ChatGPT access** sends a native-only `bridgeEnable` request. The host binds an ephemeral loopback port, acquires an exclusive discovery lock, and writes `agent-bridge.json` containing a random token. Only status and the discovery path return to the extension. The plugin discovers this file locally and authenticates each framed request. It sends commands into the same coordinator and session manager as Chrome.

Every PTY output event enters a separate 1 MiB byte ring before being sent to Chrome. MCP reads use absolute byte cursors and return at most 64 KiB; the browser's ACK window remains independent. `terminal_run` starts a command in a real PTY, waits for a bounded period, and returns the retained session ID and output cursor. It never kills a job simply because a tool's wait expires.

Agent create/rename/close operations notify all extension views with `sessionsChanged`. Views refresh the native session list and attach new terminals without stealing keyboard focus. A human can type into or interrupt the same session. Visible pane dimensions continue to follow the Chrome layout; an agent-requested resize can be superseded by a later pane resize.

`bridgeDisable` immediately invalidates authorization and queued requests, removes the discovery file, and closes the listener. It leaves accepted commands and terminal sessions running. Native process exit also removes its discovery file. Bridge enablement is never persisted across host restarts.

The packaged Node server uses stdio by default. The authenticated HTTP mode is for clients that require Streamable HTTP. OpenAI's Secure MCP Tunnel can directly launch the stdio server on the same computer; ChatGPT then calls the tunnel endpoint while the extension and PTYs remain local.

## PTY semantics

The PTY connects stdin, stdout, and stderr to a terminal device. Shell job control, password prompts, terminal-size queries, VT control sequences, and alternate-screen applications therefore behave as terminal applications rather than as processes connected to ordinary line-buffered pipes.

The host sets `TERM=xterm-256color` and uses xterm.js to interpret the terminal byte stream. The frontend sends dimensions whenever a pane is resized. On Unix, terminal input such as Ctrl+C is delivered through the PTY line discipline; on Windows, `portable-pty` uses ConPTY. The application can change terminal modes as usual.

A shell profile contains the executable, argument array, starting directory, and optional environment overrides. These are separate process-launch fields. The host does not construct an interpolated shell command from them. The user's commands typed into the shell naturally use that shell's parsing and expansion rules.

## Bytes, ordering, and flow control

The browser-native protocol transports JSON, but terminal data is not assumed to be UTF-8 text. PTY reads produce byte arrays; the host base64-encodes them; xterm.js receives the original decoded bytes. This preserves UTF-8 code points split across reads and preserves control sequences that span frames.

Every output event carries a cumulative raw-byte offset `seq`. A session can have at most 256 KiB of unacknowledged output. After writing decoded bytes to xterm.js, the frontend acknowledges the offset in xterm's parse-completion callback. The host releases credit only for offsets already emitted. If the renderer cannot keep up, the host reader stops consuming that session's PTY; OS pipe/PTY buffering then applies normal process backpressure. A bounded message channel additionally limits aggregate native stdout queue growth.

When no page is attached, the broker keeps a bounded replay window and acknowledges incoming output itself. This lets a detached process continue running without retaining an unbounded transcript. Reattaching consumes that replay window. If earlier bytes were evicted, the UI reports truncation.

Output for a newly created session can race with the create response. The broker retains early events and delivers them once ownership is established; the frontend buffers events while constructing its terminal instance. Exit follows final output from the native reader so command results are not lost when a short-lived process exits immediately.

## Ownership and concurrent windows

One native session has at most one attached interactive page. The broker rejects a second attachment until the owner detaches. Extension-page input and resize requests require ownership, preventing two pages from racing over terminal dimensions or keystrokes. The separately authorized agent bridge can also write to these same sessions; terminal input is shared with the user while enabled. Listing sessions is shared. Closing a session is an explicit action on that named session; it terminates/removes the native session.

Closing a terminal page detaches its sessions. It does not automatically destroy every shell, so another terminal page can reconnect and attach. Closing/reloading the extension or losing Chrome's native port terminates the host and its child sessions. A disconnected page does not automatically resend its last command or recreate a previous shell; a reconnect starts with live host metadata.

## Persistence boundaries

Local extension settings and saved profiles live in `chrome.storage.local`. They are not synchronized to a remote service. Terminal output is transient in xterm's scrollback and the broker's bounded replay buffer. Explicit transcript export creates a local file. The project does not continuously log commands or output.

The replay buffer contains recent bytes, not a serialized terminal emulator state. If a reattached full-screen program depended on earlier cursor movement, mode changes, or an alternate screen that fell outside the buffer, its visual state may need a redraw. The extension does not claim exact restoration after unlimited detachment. For durable shells across browser restarts, use an external multiplexer such as `tmux`, whose lifetime and screen model are independent of Chrome.

## Reuse and packaging

The Rust workspace separates wire framing/types from PTY behavior and from Chrome/installer integration. A desktop application can reuse the PTY library without a browser; a different frontend can reuse the protocol while preserving its bounds and acknowledgements. Installer paths and origin authorization are specific to the host executable.

The TypeScript broker is independent of the Chrome runtime through a small native-transport interface, so routing, ownership, early-output races, and disconnection can be tested without launching Chrome. Browser tests exercise the bundled extension separately, and native tests exercise real PTYs/protocol frames. These layers make failures distinguishable: a mock broker test cannot establish that ConPTY works on a Windows machine, while a PTY test cannot establish the extension UI's behavior.

## Performance choices

- Bounded chunks avoid megabyte-scale JSON messages and long single-frame rendering tasks.
- Base64 provides lossless byte transport through JSON with a predictable 4/3 encoding expansion.
- Cumulative byte offsets make duplicate acknowledgements harmless and avoid keeping an unbounded per-chunk acknowledgement table.
- Renderer acknowledgements propagate backpressure instead of accumulating arbitrary output in JS memory.
- Request correlation and a single native process avoid launching one OS process per command.
- The terminal renderer may use the WebGL addon when available; the normal renderer remains a fallback.

These are architectural properties, not measured throughput claims. Measure latency/output throughput on the actual OS, browser, shell, and renderer combination before setting performance budgets.

## Primary references

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [portable-pty API](https://docs.rs/portable-pty)
- [xterm.js flow-control guidance](https://xtermjs.org/docs/guides/flowcontrol/)
