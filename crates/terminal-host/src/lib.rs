//! Chrome native messaging host. Runs only for an exactly configured origin.
//!
//! stdin/stdout carry framed protocol bytes exclusively; diagnostics use stderr.
//! PTY output, stdin requests and stdout serialization have bounded queues.

mod bridge;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use bridge::{BridgeCall, BridgeCommand, BridgeState, Reply};
use crossbeam_channel::{bounded, Receiver, Sender};
use serde_json::Value;
use std::io::{self, BufReader, BufWriter};
use std::thread;
use std::time::Duration;
use terminal_protocol::{
    Command, HostInfo, Limits, Request, ServerMessage, MAX_INPUT_BYTES, MAX_SESSIONS,
    OUTPUT_WINDOW_BYTES, PROTOCOL_VERSION,
};
use terminal_pty::{shells, PtyEvent, SessionManager};

pub fn validate_origin(origin: &str, allowed_origins: &[String]) -> Result<()> {
    let id = origin
        .strip_prefix("chrome-extension://")
        .and_then(|rest| rest.strip_suffix('/'));
    if !id.is_some_and(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))) {
        bail!("Native messaging requires a canonical Chrome extension origin");
    }
    if !allowed_origins.iter().any(|allowed| allowed == origin) {
        bail!("Extension origin is not authorized in host-config.json; run the installer for this extension id");
    }
    Ok(())
}

pub fn host_info() -> HostInfo {
    HostInfo {
        protocol: PROTOCOL_VERSION,
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        home: shells::home_directory().to_string_lossy().into_owned(),
        default_shell: shells::default_shell(),
        shells: shells::discover_shells(),
        limits: Limits {
            max_sessions: MAX_SESSIONS,
            max_input_bytes: MAX_INPUT_BYTES,
            output_window_bytes: OUTPUT_WINDOW_BYTES,
        },
    }
}

enum Incoming {
    Frame(Vec<u8>),
    End,
    Error(io::Error),
}

/// Run until browser EOF, protocol framing failure, explicit shutdown or stdout
/// failure. Disconnecting the native port terminates the managed PTY sessions.
pub fn run(origin: &str, allowed_origins: &[String]) -> Result<()> {
    validate_origin(origin, allowed_origins)?;
    let executable = std::env::current_exe().context("Locate native host executable")?;
    let descriptor_path = executable
        .parent()
        .context("Native host executable has no parent directory")?
        .join("agent-bridge.json");
    let mut bridge = BridgeState::new(descriptor_path);
    let (incoming_tx, incoming_rx) = bounded(32);
    let (outgoing_tx, outgoing_rx) = bounded(64);
    let (writer_done_tx, writer_done_rx) = bounded(1);
    thread::Builder::new()
        .name("native-stdin".into())
        .spawn(move || {
            let mut reader = BufReader::new(io::stdin());
            loop {
                let (item, terminal) = match terminal_protocol::read_frame(&mut reader) {
                    Ok(Some(frame)) => (Incoming::Frame(frame), false),
                    Ok(None) => (Incoming::End, true),
                    Err(error) => (Incoming::Error(error), true),
                };
                if incoming_tx.send(item).is_err() || terminal {
                    break;
                }
            }
        })
        .context("Could not start native input reader")?;
    thread::Builder::new()
        .name("native-stdout".into())
        .spawn(move || {
            let mut writer = BufWriter::new(io::stdout());
            let result = (|| -> io::Result<()> {
                for message in outgoing_rx {
                    terminal_protocol::write_frame(&mut writer, &message)?;
                }
                Ok(())
            })();
            let _ = writer_done_tx.send(result);
        })
        .context("Could not start native output writer")?;

    let (mut sessions, events) = SessionManager::new();
    let result = dispatch_loop(
        &mut sessions,
        &mut bridge,
        &events,
        &incoming_rx,
        &outgoing_tx,
        &writer_done_rx,
    );
    bridge.disable();
    sessions.shutdown();
    drop(events);
    drop(incoming_rx);
    drop(outgoing_tx);
    // Give the output writer time to flush the shutdown acknowledgement. Do not
    // wait indefinitely for a browser that has closed or stopped consuming IO.
    if let Ok(Err(error)) = writer_done_rx.recv_timeout(Duration::from_secs(2)) {
        if result.is_ok() && error.kind() != io::ErrorKind::BrokenPipe {
            return Err(error.into());
        }
    }
    result
}

fn dispatch_loop(
    sessions: &mut SessionManager,
    bridge: &mut BridgeState,
    events: &Receiver<PtyEvent>,
    incoming: &Receiver<Incoming>,
    outgoing: &Sender<ServerMessage>,
    writer_done: &Receiver<io::Result<()>>,
) -> Result<()> {
    let bridge_requests = bridge.requests.clone();
    loop {
        crossbeam_channel::select! {
            recv(writer_done) -> done => {
                return match done {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(error)) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
                    Ok(Err(error)) => Err(error.into()),
                    Err(_) => Err(anyhow!("Native output writer stopped")),
                };
            },
            recv(incoming) -> item => match item {
                Ok(Incoming::Frame(frame)) => {
                    if handle_frame(frame, sessions, bridge, outgoing, writer_done)? { return Ok(()); }
                },
                Ok(Incoming::End) | Err(_) => return Ok(()),
                Ok(Incoming::Error(error)) => return Err(error).context("Invalid native messaging frame"),
            },
            recv(bridge_requests) -> request => {
                if let Ok(request) = request {
                    handle_bridge(request, sessions, bridge, outgoing, writer_done)?;
                }
            },
            recv(events) -> event => {
                let message = match event {
                    Ok(PtyEvent::Output {session_id, data, seq}) if sessions.contains(&session_id) => {
                        bridge.output(&session_id, &data, seq);
                        ServerMessage::Output {session_id, data: STANDARD.encode(data), seq}
                    },
                    Ok(PtyEvent::Exit {session_id, exit_code}) if sessions.contains(&session_id) => {
                        bridge.exited(&session_id, exit_code);
                        ServerMessage::Exit {session_id, exit_code}
                    },
                    Ok(_) => continue, // a recently closed session's queued output
                    Err(_) => return Err(anyhow!("PTY event channel stopped")),
                };
                send(outgoing, writer_done, message)?;
            }
        }
    }
}

fn send(
    outgoing: &Sender<ServerMessage>,
    writer_done: &Receiver<io::Result<()>>,
    message: ServerMessage,
) -> Result<()> {
    crossbeam_channel::select! {
        send(outgoing, message) -> result => result.context("Native output channel closed"),
        recv(writer_done) -> _ => Err(anyhow!("Native output writer stopped")),
    }
}

fn handle_frame(
    frame: Vec<u8>,
    sessions: &mut SessionManager,
    bridge: &mut BridgeState,
    outgoing: &Sender<ServerMessage>,
    writer_done: &Receiver<io::Result<()>>,
) -> Result<bool> {
    let value: Value = match serde_json::from_slice(&frame) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Invalid native JSON: {error}");
            return Ok(false);
        }
    };
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .map(str::to_owned);
    let request: Request = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(error) => {
            if let Some(id) = id {
                send(
                    outgoing,
                    writer_done,
                    ServerMessage::error(id, "invalid_request", error.to_string()),
                )?;
            }
            return Ok(false);
        }
    };
    if let Err(error) = request.validate() {
        if let Some(id) = id {
            send(
                outgoing,
                writer_done,
                ServerMessage::error(id, "invalid_request", error),
            )?;
        }
        return Ok(false);
    }
    let shutdown = matches!(&request.command, Command::Shutdown);
    let result = execute(request.command, sessions, bridge);
    if let Some(id) = request.id {
        let response = match result {
            Ok(value) => ServerMessage::success(id, value),
            Err(error) => ServerMessage::error(id, "operation_failed", format!("{error:#}")),
        };
        send(outgoing, writer_done, response)?;
    } else if let Err(error) = result {
        eprintln!("Native request failed: {error:#}");
    }
    Ok(shutdown)
}

fn handle_bridge(
    call: BridgeCall,
    sessions: &mut SessionManager,
    bridge: &mut BridgeState,
    outgoing: &Sender<ServerMessage>,
    writer_done: &Receiver<io::Result<()>>,
) -> Result<()> {
    if !call.is_live() {
        let _ = call.response.try_send(Reply::error(
            "unavailable",
            "The bridge was disabled or this request expired",
        ));
        return Ok(());
    }
    let (result, changed) = match call.command {
        BridgeCommand::Read(options) => (bridge.read(&options), false),
        BridgeCommand::Native(command) => {
            let changed = matches!(
                command,
                Command::Create(_) | Command::Rename { .. } | Command::Close { .. }
            );
            (execute(command, sessions, bridge), changed)
        }
    };
    if changed && result.is_ok() {
        // The extension discovers and attaches agent-created sessions before
        // handling their output. It alone owns the native output ACK window.
        send(outgoing, writer_done, ServerMessage::SessionsChanged)?;
    }
    let reply = match result {
        Ok(value) => Reply::success(value),
        Err(error) => Reply::error("operation_failed", format!("{error:#}")),
    };
    // A vanished or timed-out client cannot block the PTY coordinator.
    let _ = call.response.try_send(reply);
    Ok(())
}

fn execute(
    command: Command,
    sessions: &mut SessionManager,
    bridge: &mut BridgeState,
) -> Result<Value> {
    match command {
        Command::Hello => Ok(serde_json::to_value(host_info())?),
        Command::List => Ok(serde_json::to_value(sessions.list())?),
        Command::Create(options) => {
            let session = sessions.create(options)?;
            bridge.created(&session.id);
            Ok(serde_json::to_value(session)?)
        }
        Command::Input { session_id, data } => {
            let data = STANDARD
                .decode(data)
                .context("Input must be canonical base64")?;
            sessions.input(&session_id, data)?;
            Ok(Value::Null)
        }
        Command::Resize {
            session_id,
            cols,
            rows,
        } => {
            sessions.resize(&session_id, cols, rows)?;
            Ok(Value::Null)
        }
        Command::Rename { session_id, title } => {
            sessions.rename(&session_id, title)?;
            Ok(Value::Null)
        }
        Command::Close { session_id } => {
            sessions.close(&session_id)?;
            bridge.closed(&session_id);
            Ok(Value::Null)
        }
        Command::Ack { session_id, seq } => {
            sessions.acknowledge(&session_id, seq)?;
            Ok(Value::Null)
        }
        Command::Shutdown => Ok(Value::Null),
        Command::BridgeEnable => bridge.enable(),
        Command::BridgeDisable => Ok(bridge.disable()),
        Command::BridgeStatus => Ok(bridge.status()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_is_exact_and_never_uses_prefix_matching() {
        let good = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
        let allowed = vec![good.to_string()];
        assert!(validate_origin(good, &allowed).is_ok());
        for origin in [
            "https://abcdefghijklmnopabcdefghijklmnop/",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/evil",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop.evil/",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnox/",
        ] {
            assert!(validate_origin(origin, &allowed).is_err(), "{origin}");
        }
        assert!(validate_origin(good, &[]).is_err());
    }

    #[test]
    fn hello_describes_engine_limits() {
        let info = host_info();
        assert_eq!(info.protocol, 1);
        assert_eq!(info.limits.max_input_bytes, MAX_INPUT_BYTES);
        assert_eq!(info.limits.output_window_bytes, OUTPUT_WINDOW_BYTES);
        assert!(!info.home.is_empty());
    }
}
