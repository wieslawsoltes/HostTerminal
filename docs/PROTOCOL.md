# Wire protocol v1

The canonical field definitions are in `crates/terminal-protocol/src/lib.rs` and `extension/src/protocol.ts`. This document describes the external contract, not an invitation for arbitrary web pages to invoke the host.

## Transport

The host reads stdin and writes stdout. A frame consists of a native-endian unsigned 32-bit JSON-byte length followed by that many UTF-8 JSON bytes. Lengths count bytes, not characters. One frame contains one object. Native stdout contains no log lines or other text; diagnostics use stderr.

Both directions have an application-level 1 MiB frame limit. Output chunks are at most 16 KiB before base64 encoding. Chrome itself imposes a 1 MiB native-to-extension limit; this project deliberately caps extension-to-native messages below Chrome's larger maximum as well.

EOF at a frame boundary ends the connection normally. Partial prefixes/payloads, zero-length frames, invalid UTF-8/JSON, and oversized lengths are rejected. A claimed large length is checked before payload allocation. After connection loss, session cleanup runs.

## Requests and results

Each request has a `type` and may have an `id` containing 1–128 bytes without NUL. Requests with IDs receive one correlated result. Fire-and-forget acknowledgements omit the ID.

```json
{"id":"r1","type":"hello"}
```

Successful result:

```json
{"id":"r1","type":"result","ok":true,"value":{"protocol":1,"version":"0.1.0"}}
```

The example omits the rest of hello's fields for readability. The complete value contains `protocol`, `version`, `os`, `arch`, `home`, `defaultShell`, `shells`, and `limits`.

Failure result:

```json
{"id":"r2","type":"result","ok":false,"error":{"code":"REQUEST_FAILED","message":"Session no longer exists"}}
```

Clients must treat error messages as text. Error codes distinguish host validation/operation failures where supplied; callers should not parse human-readable messages as a stable API. A transport failure rejects outstanding requests separately from a normal error response.

| Type | Fields | Successful value |
| --- | --- | --- |
| `hello` | None | Host metadata, detected shells, limits |
| `list` | None | Array of session metadata |
| `create` | `cols`, `rows`; optional `shell`, `args`, `cwd`, `env`, `title` | New session metadata |
| `input` | `sessionId`, base64 `data` | `null` |
| `resize` | `sessionId`, `cols`, `rows` | `null` |
| `rename` | `sessionId`, `title` | `null` |
| `close` | `sessionId` | `null` |
| `ack` | `sessionId`, cumulative byte `seq` | `null` only if an ID was supplied |
| `shutdown` | None | `null`, followed by host shutdown |

`create.args` is an array, not a shell-interpreted string. `env` is an object mapping environment variable names to string values. `cwd` is an initial directory; it does not track later `cd` commands. Omitting the shell selects the host's default. The host checks process arguments, environment, terminal dimensions, title length, and session count before allocating a session.

Session metadata fields:

```json
{
  "id":"uuid-session-id",
  "title":"Development",
  "shell":"/bin/bash",
  "args":["-l"],
  "cwd":"/home/example",
  "cols":120,
  "rows":36,
  "pid":12345,
  "createdAt":1792950000000,
  "exited":false
}
```

`createdAt` is Unix milliseconds. `pid` may be `null`. `exitCode` appears after exit. The title is user-facing text and must never be inserted as HTML. The session UUID is an identifier, not an authorization token; ownership is enforced by the extension broker.

## Events

```json
{"type":"output","sessionId":"uuid-session-id","data":"aGVsbG8NCg==","seq":7}
```

`data` decodes to the seven raw bytes `hello\r\n`. `seq` counts all raw bytes emitted by this session so far. It does not count JSON bytes, base64 characters, terminal cells, or JavaScript string length. The sequence is monotonic.

```json
{"type":"exit","sessionId":"uuid-session-id","exitCode":0}
```

The host emits final output before exit. A session can remain listed with its exit metadata until explicitly closed. Clients should stop sending input after exit while allowing the user to inspect/export its scrollback.

## Acknowledgements

After xterm.js has parsed an output chunk, the renderer sends:

```json
{"type":"ack","sessionId":"uuid-session-id","seq":7}
```

Acknowledgements are cumulative. Stale/duplicate offsets do not return extra credit; an offset beyond emitted output is invalid. Outstanding raw output is limited to 256 KiB per session. Read loops wait for credit, and closing a session wakes any blocked waiters. A detached session is acknowledged by the broker while only bounded recent output is retained.

Output cannot be acknowledged merely because a WebExtension message was delivered: that would bound the native queue but leave xterm's parser queue unbounded. Use xterm's `write(bytes, completion)` callback to return credit.

## Extension-only operations

The page-to-worker API adds operations that never reach the native host:

- `connect` opens/reuses the native connection and performs `hello`.
- `attach {sessionId}` claims a session for a page and returns `{session, replay, truncated}`.
- `detach {sessionId}` releases ownership and lets the broker acknowledge output.

The worker returns `disconnected` events when the native connection is lost. These messages are scoped to extension pages. No content script, external origin, or regular website receives this API.

## Current bounds

| Resource | Limit |
| --- | --- |
| Sessions per native connection | 16 |
| Application frame | 1 MiB |
| Decoded input per request | 64 KiB |
| Raw output per event | 16 KiB |
| Unacknowledged raw output per session | 256 KiB |
| Columns | 2–1,000 |
| Rows | 1–1,000 |
| Request ID | 1–128 bytes, no NUL |

Additional string/environment limits are encoded in the Rust validators. A future incompatible change must increment `protocol`; clients reject a mismatched protocol version rather than guessing how to decode it.

## Optional agent bridge (version 0.2.0)

Only the trusted extension can issue native `bridgeEnable`, `bridgeDisable`, or `bridgeStatus` requests. They return `{ "enabled": false }` or `{ "enabled": true, "port": 12345, "descriptorPath": "/installed/path/agent-bridge.json" }`. The token is never returned over Chrome IPC. `sessionsChanged` is an event with no session ID; it instructs views to refresh their list after agent create, rename or close.

The private descriptor contains `protocol: 1`, `port`, `token` (64 hexadecimal characters), and `pid`. The native host writes it next to its installed executable. A bridge TCP connection sends one native-endian u32 length followed by UTF-8 JSON `{ "token": "...", "request": { "type": "list" } }`. The reply has `{ "ok": true, "value": ... }` or `{ "ok": false, "error": { "code": "...", "message": "..." } }`. Maximum frames are 1 MiB.

Allowed request types are `hello`, `list`, `create`, `input`, `resize`, `rename`, `close`, and `read`. The ordinary terminal requests retain their native shapes. The bridge rejects `ack`, `shutdown`, and all `bridge*` commands.

`read` takes `sessionId`, an optional byte `cursor` (default 0), and optional `maxBytes` (1–65536, default 65536). It returns `sessionId`, base64 `data`, next `cursor`, `oldestCursor`, `endCursor`, `truncated`, `exited`, and `exitCode` after final output. A cursor older than the 1 MiB ring clamps forward and reports truncation; a cursor beyond the end is rejected. Reading never changes Chrome's output credit.

Native error codes include `unauthorized`, `forbidden`, `invalid_request`, `unavailable`, `busy`, `timeout`, and `operation_failed`. Disabling invalidates queued requests before execution; it cannot undo a shell operation that already started. The MCP adapter converts these into structured tool errors and never automatically retries a mutation after an uncertain transport result.
