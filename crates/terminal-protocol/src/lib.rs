//! Host Terminal wire protocol and defensive Chrome native-messaging framing.
//!
//! Payload lengths count UTF-8 bytes, not Unicode characters. Chrome specifies
//! native-endian u32 framing; all application frames are capped at one MiB.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u32 = 1;
pub const HOST_NAME: &str = "com.host_terminal.host";
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
pub const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
pub const OUTPUT_WINDOW_BYTES: usize = 256 * 1024;
pub const MAX_SESSIONS: usize = 16;
pub const MAX_DIMENSION: u16 = 1000;

#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Hello,
    List,
    Create(CreateOptions),
    Input {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Rename {
        session_id: String,
        title: String,
    },
    Close {
        session_id: String,
    },
    Ack {
        session_id: String,
        seq: u64,
    },
    Shutdown,
    BridgeEnable,
    BridgeDisable,
    BridgeStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOptions {
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub title: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub shell: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub pid: Option<u32>,
    pub created_at: u64,
    pub exited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellProfile {
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub protocol: u32,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub home: String,
    pub default_shell: String,
    pub shells: Vec<ShellProfile>,
    pub limits: Limits,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_sessions: usize,
    pub max_input_bytes: usize,
    pub output_window_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct WireError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerMessage {
    Result {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<WireError>,
    },
    Output {
        session_id: String,
        data: String,
        seq: u64,
    },
    Exit {
        session_id: String,
        exit_code: u32,
    },
    SessionsChanged,
}

impl ServerMessage {
    pub fn success(id: String, value: Value) -> Self {
        Self::Result {
            id,
            ok: true,
            value: Some(value),
            error: None,
        }
    }

    pub fn error(id: String, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Result {
            id,
            ok: false,
            value: None,
            error: Some(WireError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

impl Request {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(id) = &self.id {
            if id.is_empty() || id.len() > 128 || id.contains('\0') {
                return Err("Request id must contain 1–128 bytes and no NUL".into());
            }
        }
        match &self.command {
            Command::Create(options) => options.validate(),
            Command::Input { session_id, data } => {
                validate_session_id(session_id)?;
                if data.len() > MAX_INPUT_BYTES.div_ceil(3) * 4 {
                    return Err("Input exceeds 64 KiB".into());
                }
                Ok(())
            }
            Command::Resize {
                session_id,
                cols,
                rows,
            } => {
                validate_session_id(session_id)?;
                validate_size(*cols, *rows)
            }
            Command::Rename { session_id, title } => {
                validate_session_id(session_id)?;
                validate_title(title)
            }
            Command::Close { session_id } | Command::Ack { session_id, .. } => {
                validate_session_id(session_id)
            }
            _ => Ok(()),
        }
    }
}

impl CreateOptions {
    pub fn validate(&self) -> Result<(), String> {
        validate_size(self.cols, self.rows)?;
        if let Some(shell) = &self.shell {
            validate_text(shell, 8192, "Shell")?;
            if shell.is_empty() {
                return Err("Shell must not be empty".into());
            }
        }
        if let Some(cwd) = &self.cwd {
            validate_text(cwd, 32768, "Working directory")?;
        }
        if let Some(title) = &self.title {
            validate_title(title)?;
        }
        if let Some(args) = &self.args {
            if args.len() > 128 || args.iter().map(String::len).sum::<usize>() > 65536 {
                return Err("Too many or oversized shell arguments".into());
            }
            for arg in args {
                validate_text(arg, 8192, "Shell argument")?;
            }
        }
        if self.env.len() > 256
            || self
                .env
                .iter()
                .map(|(k, v)| k.len() + v.len())
                .sum::<usize>()
                > 131072
        {
            return Err("Environment exceeds limits".into());
        }
        for (key, value) in &self.env {
            validate_text(key, 1024, "Environment name")?;
            validate_text(value, 65536, "Environment value")?;
            if key.is_empty() || key.contains('=') {
                return Err("Environment names must be nonempty and must not contain '='".into());
            }
        }
        Ok(())
    }
}

pub fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
    if !(2..=MAX_DIMENSION).contains(&cols) || !(1..=MAX_DIMENSION).contains(&rows) {
        Err(format!(
            "Terminal size must be 2–{MAX_DIMENSION} columns and 1–{MAX_DIMENSION} rows"
        ))
    } else {
        Ok(())
    }
}

fn validate_text(value: &str, max: usize, name: &str) -> Result<(), String> {
    if value.len() > max || value.contains('\0') {
        Err(format!("{name} exceeds {max} bytes or contains NUL"))
    } else {
        Ok(())
    }
}

pub fn validate_title(title: &str) -> Result<(), String> {
    validate_text(title, 256, "Title")?;
    if title.chars().any(char::is_control) {
        return Err("Title must not contain control characters".into());
    }
    Ok(())
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Err("Invalid session id".into())
    } else {
        Ok(())
    }
}

/// Read exactly one bounded frame. A clean EOF before a header is `Ok(None)`;
/// partial headers/payloads are errors and must never be silently retried.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    reader.read_exact(&mut header[1..])?;
    let len = u32::from_ne_bytes(header) as usize;
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid native frame length",
        ));
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, message: &T) -> io::Result<()> {
    let body = serde_json::to_vec(message).map_err(io::Error::other)?;
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Outgoing native frame exceeds limit",
        ));
    }
    writer.write_all(&(body.len() as u32).to_ne_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct Fragmented(Cursor<Vec<u8>>);
    impl Read for Fragmented {
        fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
            let n = target.len().min(1);
            self.0.read(&mut target[..n])
        }
    }

    #[test]
    fn fragmented_frames_count_utf8_bytes_and_roundtrip() {
        let value = serde_json::json!({"text":"Zażółć 🦀 東京"});
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &value).unwrap();
        let length = u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(length, bytes.len() - 4);
        let mut reader = Fragmented(Cursor::new(bytes));
        let body = read_frame(&mut reader).unwrap().unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), value);
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn partial_header_and_body_are_not_clean_eof() {
        assert_eq!(
            read_frame(&mut Cursor::new(vec![1, 0])).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut bytes = 10_u32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        assert_eq!(
            read_frame(&mut Cursor::new(bytes)).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn oversized_or_zero_frame_rejected_before_allocation() {
        for n in [0_u32, (MAX_FRAME_BYTES + 1) as u32, u32::MAX] {
            assert_eq!(
                read_frame(&mut Cursor::new(n.to_ne_bytes()))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidData
            );
        }
    }

    #[test]
    fn request_validation_rejects_invalid_dimensions_env_and_ids() {
        for value in [
            serde_json::json!({"id":"a","type":"create","cols":0,"rows":24}),
            serde_json::json!({"id":"a","type":"create","cols":80,"rows":24,"env":{"A=B":"x"}}),
            serde_json::json!({"id":"a","type":"input","sessionId":"../bad","data":"YQ=="}),
            serde_json::json!({"id":"a","type":"rename","sessionId":"one","title":"\u{001b}[2J"}),
        ] {
            let request: Request = serde_json::from_value(value).unwrap();
            assert!(request.validate().is_err());
        }
    }

    #[test]
    fn camel_case_request_and_event_contract() {
        let request: Request = serde_json::from_value(
            serde_json::json!({"type":"ack","sessionId":"abc-123","seq":42}),
        )
        .unwrap();
        assert!(matches!(request.command, Command::Ack { seq: 42, .. }));
        let message = ServerMessage::Output {
            session_id: "abc".into(),
            data: "AA==".into(),
            seq: 1,
        };
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            serde_json::json!({"type":"output","sessionId":"abc","data":"AA==","seq":1})
        );
    }
}
