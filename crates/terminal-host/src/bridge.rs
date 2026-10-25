//! An explicitly enabled, authenticated loopback bridge into the native host.
//!
//! Networking never runs on the PTY coordinator. The browser remains the owner
//! of sessions and output acknowledgements; bridge readers only copy a bounded
//! output history. A connection carries exactly one request and response.

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use crossbeam_channel::{bounded, Receiver, Sender};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use terminal_protocol::{Command, Request, WireError};

const HISTORY_BYTES: usize = 1024 * 1024;
const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 16;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const DESCRIPTOR_BYTES: u64 = 4096;
// Winsock can delay a refused loopback connection while it retries the SYN.
// Give it time to report ConnectionRefused; a short deadline produces TimedOut,
// which correctly cannot establish that a descriptor is stale.
#[cfg(windows)]
const STALE_PROBE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(not(windows))]
const STALE_PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Deserialize, Serialize)]
struct Descriptor {
    protocol: u32,
    port: u16,
    token: String,
    pid: u32,
}

#[derive(Deserialize)]
struct Envelope {
    token: String,
    request: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadOptions {
    pub session_id: String,
    #[serde(default)]
    pub cursor: u64,
    #[serde(default = "default_read_bytes")]
    pub max_bytes: usize,
}

fn default_read_bytes() -> usize {
    MAX_READ_BYTES
}

pub(crate) enum BridgeCommand {
    Native(Command),
    Read(ReadOptions),
}

#[derive(Serialize)]
pub(crate) struct Reply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<WireError>,
}

impl Reply {
    pub(crate) fn success(value: Value) -> Self {
        Self {
            ok: true,
            value: Some(value),
            error: None,
        }
    }

    pub(crate) fn error(code: &str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(WireError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

pub(crate) struct BridgeCall {
    pub command: BridgeCommand,
    pub response: Sender<Reply>,
    enabled: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

impl BridgeCall {
    /// Rechecked immediately before dispatch so a queued mutation cannot run
    /// after its bridge generation is disabled or its client times out.
    pub(crate) fn is_live(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
            && !self.cancelled.load(Ordering::Acquire)
            && Instant::now() < self.deadline
    }
}

#[derive(Default)]
struct OutputHistory {
    bytes: VecDeque<u8>,
    end: u64,
    exited: bool,
    exit_code: Option<u32>,
}

impl OutputHistory {
    fn append(&mut self, data: &[u8], seq: u64) {
        // Sequence offsets describe raw PTY bytes, before base64 encoding.
        // A gap is not expected, but never report missing bytes as contiguous.
        if seq.saturating_sub(data.len() as u64) != self.end {
            self.bytes.clear();
        }
        self.end = seq;
        if data.len() >= HISTORY_BYTES {
            self.bytes.clear();
            self.bytes.extend(&data[data.len() - HISTORY_BYTES..]);
        } else {
            let remove = (self.bytes.len() + data.len()).saturating_sub(HISTORY_BYTES);
            self.bytes.drain(..remove);
            self.bytes.extend(data);
        }
    }

    fn read(&self, options: &ReadOptions) -> Result<Value> {
        if options.max_bytes == 0 || options.max_bytes > MAX_READ_BYTES {
            bail!("maxBytes must be between 1 and {MAX_READ_BYTES}");
        }
        if options.cursor > self.end {
            bail!("Read cursor exceeds the output received by the native host");
        }
        let oldest = self.end - self.bytes.len() as u64;
        let start = options.cursor.max(oldest);
        let offset = (start - oldest) as usize;
        let length = options.max_bytes.min(self.bytes.len() - offset);
        let bytes: Vec<u8> = self.bytes.range(offset..offset + length).copied().collect();
        let mut value = json!({
            "sessionId": options.session_id,
            "data": STANDARD.encode(bytes),
            "cursor": start + length as u64,
            "oldestCursor": oldest,
            "endCursor": self.end,
            "truncated": options.cursor < oldest,
            "exited": self.exited,
        });
        if let Some(exit_code) = self.exit_code {
            value["exitCode"] = json!(exit_code);
        }
        Ok(value)
    }
}

struct Server {
    enabled: Arc<AtomicBool>,
    port: u16,
    token: String,
    descriptor_path: PathBuf,
    // An OS file lock serializes live native hosts and stale-file replacement.
    // Keep it until after disabling the listener and removing our descriptor.
    _lock: File,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.enabled.store(false, Ordering::Release);
        remove_own_descriptor(&self.descriptor_path, &self.token);
    }
}

pub(crate) struct BridgeState {
    server: Option<Server>,
    descriptor_path: PathBuf,
    requests_tx: Sender<BridgeCall>,
    pub requests: Receiver<BridgeCall>,
    connections: Arc<AtomicUsize>,
    histories: BTreeMap<String, OutputHistory>,
}

impl BridgeState {
    pub(crate) fn new(descriptor_path: PathBuf) -> Self {
        let (requests_tx, requests) = bounded(64);
        Self {
            server: None,
            descriptor_path,
            requests_tx,
            requests,
            connections: Arc::new(AtomicUsize::new(0)),
            histories: BTreeMap::new(),
        }
    }

    pub(crate) fn status(&self) -> Value {
        match &self.server {
            Some(server) => json!({"enabled": true, "port": server.port,
                "descriptorPath": server.descriptor_path.to_string_lossy()}),
            None => json!({"enabled": false}),
        }
    }

    pub(crate) fn enable(&mut self) -> Result<Value> {
        if self.server.is_some() {
            return Ok(self.status());
        }
        let lock = open_lock(&self.descriptor_path.with_extension("lock"))?;
        lock.try_lock().map_err(|_| {
            anyhow!(
            "Another native host has enabled the ChatGPT bridge; disable it in its browser first"
        )
        })?;
        reclaim_stale_descriptor(&self.descriptor_path)?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .context("Could not open loopback bridge listener")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random)
            .map_err(|_| anyhow!("Could not obtain secure bridge randomness"))?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let descriptor = Descriptor {
            protocol: 1,
            port,
            token: token.clone(),
            pid: std::process::id(),
        };
        write_descriptor(&self.descriptor_path, &descriptor)?;
        let enabled = Arc::new(AtomicBool::new(true));
        let server = Server {
            enabled: enabled.clone(),
            port,
            token: token.clone(),
            descriptor_path: self.descriptor_path.clone(),
            _lock: lock,
        };
        let requests = self.requests_tx.clone();
        let connections = self.connections.clone();
        thread::Builder::new()
            .name("agent-bridge-listener".into())
            .spawn(move || {
                listen(listener, enabled, token, requests, connections);
            })
            .context("Could not start ChatGPT bridge listener")?;
        self.server = Some(server);
        Ok(self.status())
    }

    pub(crate) fn disable(&mut self) -> Value {
        self.server.take();
        self.status()
    }

    pub(crate) fn created(&mut self, id: &str) {
        self.histories.insert(id.into(), OutputHistory::default());
    }

    pub(crate) fn closed(&mut self, id: &str) {
        self.histories.remove(id);
    }

    pub(crate) fn output(&mut self, id: &str, data: &[u8], seq: u64) {
        self.histories
            .entry(id.into())
            .or_default()
            .append(data, seq);
    }

    pub(crate) fn exited(&mut self, id: &str, exit_code: u32) {
        let history = self.histories.entry(id.into()).or_default();
        history.exited = true;
        history.exit_code = Some(exit_code);
    }

    pub(crate) fn read(&self, options: &ReadOptions) -> Result<Value> {
        self.histories
            .get(&options.session_id)
            .context("Session does not exist")?
            .read(options)
    }
}

fn check_regular_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                bail!("Bridge state must be a regular file");
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    bail!("Bridge state permissions must allow access only to its owner");
                }
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("Inspect bridge state"),
    }
}

fn private_options() -> OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.mode(0o600);
        options
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
    }
}

fn open_lock(path: &Path) -> Result<File> {
    check_regular_file(path)?;
    private_options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .context("Open bridge ownership lock")
}

fn read_descriptor(path: &Path) -> Result<Descriptor> {
    check_regular_file(path)?;
    let mut bytes = Vec::new();
    File::open(path)?
        .take(DESCRIPTOR_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > DESCRIPTOR_BYTES {
        bail!("Bridge descriptor is too large");
    }
    let descriptor: Descriptor =
        serde_json::from_slice(&bytes).map_err(|_| anyhow!("Bridge descriptor is invalid"))?;
    if descriptor.protocol != 1
        || descriptor.port == 0
        || descriptor.pid == 0
        || descriptor.token.len() != 64
        || !descriptor.token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        bail!("Bridge descriptor is invalid");
    }
    Ok(descriptor)
}

fn write_descriptor(path: &Path, descriptor: &Descriptor) -> Result<()> {
    let mut file = private_options()
        .write(true)
        .create_new(true)
        .open(path)
        .context("Create private bridge descriptor")?;
    let result = (|| -> Result<()> {
        serde_json::to_writer(&mut file, descriptor)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        // The caller holds the ownership lock and this file was create_new.
        drop(file);
        let _ = fs::remove_file(path);
    }
    result.context("Write private bridge descriptor")
}

fn remove_own_descriptor(path: &Path, token: &str) {
    if read_descriptor(path).is_ok_and(|d| token_matches(&d.token, token)) {
        let _ = fs::remove_file(path);
    }
}

fn reclaim_stale_descriptor(path: &Path) -> Result<()> {
    reclaim_stale_descriptor_with_connect(path, TcpStream::connect_timeout)
}

fn reclaim_stale_descriptor_with_connect(
    path: &Path,
    connect: impl FnOnce(&SocketAddr, Duration) -> io::Result<TcpStream>,
) -> Result<()> {
    if !path.try_exists()? {
        return Ok(());
    }
    let descriptor = read_descriptor(path)?;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, descriptor.port));
    match connect(&address, STALE_PROBE_CONNECT_TIMEOUT) {
        Ok(mut stream) => {
            stream.set_read_timeout(Some(Duration::from_millis(500)))?;
            stream.set_write_timeout(Some(Duration::from_millis(500)))?;
            // A successful authenticated reply proves a live bridge. A port
            // that accepts but does not answer is also left intact: uncertainty
            // must never let a new host take over another live host's state.
            let probe = json!({"token": descriptor.token, "request": {"type": "hello"}});
            let authenticated = terminal_protocol::write_frame(&mut stream, &probe).is_ok()
                && read_frame_deadline(&mut stream, Duration::from_millis(500))
                    .ok()
                    .flatten()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .is_some_and(|reply| reply.get("ok") == Some(&Value::Bool(true)));
            if authenticated {
                bail!("An authenticated ChatGPT bridge is already running in another native host");
            }
            bail!("The existing bridge port is reachable; its descriptor was preserved");
        }
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            // All cooperating hosts hold the same OS lock during replacement.
            remove_own_descriptor(path, &descriptor.token);
            if path.try_exists()? {
                bail!("Could not remove stale bridge descriptor");
            }
            Ok(())
        }
        Err(error) => {
            Err(error).context("Could not establish whether the existing bridge is still running")
        }
    }
}

fn token_matches(expected: &str, supplied: &str) -> bool {
    expected.as_bytes().ct_eq(supplied.as_bytes()).into()
}

/// SO_RCVTIMEO alone restarts on each read. Keep one deadline for the complete
/// header and payload so a client cannot hold a slot by trickling bytes.
fn read_frame_deadline(stream: &mut TcpStream, timeout: Duration) -> io::Result<Option<Vec<u8>>> {
    struct DeadlineReader<'a> {
        stream: &'a mut TcpStream,
        deadline: Instant,
    }
    impl Read for DeadlineReader<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let remaining = self
                .deadline
                .checked_duration_since(Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::TimedOut, "Bridge frame deadline elapsed")
                })?;
            self.stream.set_read_timeout(Some(remaining))?;
            self.stream.read(buffer)
        }
    }
    terminal_protocol::read_frame(&mut DeadlineReader {
        stream,
        deadline: Instant::now() + timeout,
    })
}

struct ConnectionPermit(Arc<AtomicUsize>);
impl ConnectionPermit {
    fn acquire(connections: &Arc<AtomicUsize>) -> Option<Self> {
        let mut count = connections.load(Ordering::Acquire);
        loop {
            if count >= MAX_CONNECTIONS {
                return None;
            }
            match connections.compare_exchange_weak(
                count,
                count + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Self(connections.clone())),
                Err(current) => count = current,
            }
        }
    }
}
impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn listen(
    listener: TcpListener,
    enabled: Arc<AtomicBool>,
    token: String,
    requests: Sender<BridgeCall>,
    connections: Arc<AtomicUsize>,
) {
    while enabled.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, peer)) => {
                if !peer.ip().is_loopback() || !enabled.load(Ordering::Acquire) {
                    continue;
                }
                let Some(permit) = ConnectionPermit::acquire(&connections) else {
                    // Close excess connections without blocking the listener.
                    continue;
                };
                let token = token.clone();
                let enabled = enabled.clone();
                let requests = requests.clone();
                // Dropping the closure also releases the permit on spawn error.
                let _ = thread::Builder::new()
                    .name("agent-bridge-rpc".into())
                    .spawn(move || {
                        let _permit = permit;
                        serve(stream, &token, enabled, requests);
                    });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn parse_command(value: Value) -> std::result::Result<BridgeCommand, Reply> {
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return Err(Reply::error("invalid_request", "Request must have a type"));
    };
    match kind {
        "read" => {
            let options: ReadOptions = serde_json::from_value(value)
                .map_err(|_| Reply::error("invalid_request", "Invalid read request"))?;
            // Reuse native session-id validation rather than introduce a second
            // syntax. Read sizing is enforced before dispatch and again by ring.
            let validation = Request {
                id: None,
                command: Command::Close {
                    session_id: options.session_id.clone(),
                },
            };
            validation
                .validate()
                .map_err(|error| Reply::error("invalid_request", error))?;
            if options.max_bytes == 0 || options.max_bytes > MAX_READ_BYTES {
                return Err(Reply::error(
                    "invalid_request",
                    "maxBytes must be between 1 and 65536",
                ));
            }
            Ok(BridgeCommand::Read(options))
        }
        "hello" | "list" | "create" | "input" | "resize" | "rename" | "close" => {
            let request: Request = serde_json::from_value(value)
                .map_err(|_| Reply::error("invalid_request", "Invalid bridge request"))?;
            request
                .validate()
                .map_err(|error| Reply::error("invalid_request", error))?;
            Ok(BridgeCommand::Native(request.command))
        }
        _ => Err(Reply::error(
            "forbidden",
            "This command is not available through the bridge",
        )),
    }
}

fn serve(
    mut stream: TcpStream,
    token: &str,
    enabled: Arc<AtomicBool>,
    requests: Sender<BridgeCall>,
) {
    if stream.set_read_timeout(Some(SOCKET_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(SOCKET_TIMEOUT)).is_err()
    {
        return;
    }
    let reply = (|| -> std::result::Result<Reply, Reply> {
        let bytes = read_frame_deadline(&mut stream, SOCKET_TIMEOUT)
            .map_err(|_| Reply::error("invalid_request", "Invalid or incomplete bridge frame"))?
            .ok_or_else(|| Reply::error("invalid_request", "Missing bridge request"))?;
        let envelope: Envelope = serde_json::from_slice(&bytes)
            .map_err(|_| Reply::error("invalid_request", "Invalid bridge envelope"))?;
        if !enabled.load(Ordering::Acquire) {
            return Err(Reply::error("unavailable", "The bridge has been disabled"));
        }
        if !token_matches(token, &envelope.token) {
            return Err(Reply::error("unauthorized", "Invalid bridge credentials"));
        }
        let command = parse_command(envelope.request)?;
        let (response, result) = bounded(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        let call = BridgeCall {
            command,
            response,
            enabled,
            cancelled: cancelled.clone(),
            deadline: Instant::now() + REQUEST_TIMEOUT,
        };
        requests
            .try_send(call)
            .map_err(|_| Reply::error("busy", "The native host request queue is full"))?;
        let answer = result.recv_timeout(REQUEST_TIMEOUT);
        cancelled.store(true, Ordering::Release);
        answer.map_err(|_| {
            Reply::error(
                "timeout",
                "The native host did not respond before the deadline",
            )
        })
    })();
    let reply = match reply {
        Ok(reply) | Err(reply) => reply,
    };
    let _ = terminal_protocol::write_frame(&mut stream, &reply);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "host-terminal-bridge-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn descriptor(&self) -> PathBuf {
            self.0.join("agent-bridge.json")
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn rpc(port: u16, token: &str, request: Value) -> Value {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        terminal_protocol::write_frame(&mut stream, &json!({"token": token, "request": request}))
            .unwrap();
        serde_json::from_slice(&terminal_protocol::read_frame(&mut stream).unwrap().unwrap())
            .unwrap()
    }

    #[test]
    fn bridge_is_opt_in_private_and_token_rotates() {
        let dir = TempDir::new();
        let mut state = BridgeState::new(dir.descriptor());
        assert_eq!(state.status(), json!({"enabled": false}));
        assert!(!dir.descriptor().exists());
        let status = state.enable().unwrap();
        assert_eq!(status["enabled"], true);
        assert!(status.get("token").is_none());
        let first = read_descriptor(&dir.descriptor()).unwrap();
        assert_eq!(first.token.len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.descriptor()).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(state.disable(), json!({"enabled": false}));
        assert!(!dir.descriptor().exists());
        state.enable().unwrap();
        assert_ne!(
            first.token,
            read_descriptor(&dir.descriptor()).unwrap().token
        );
        drop(state);
        assert!(!dir.descriptor().exists());
    }

    #[test]
    fn loopback_authentication_and_command_allowlist() {
        let dir = TempDir::new();
        let mut state = BridgeState::new(dir.descriptor());
        state.enable().unwrap();
        let descriptor = read_descriptor(&dir.descriptor()).unwrap();
        let bad = rpc(descriptor.port, &"0".repeat(64), json!({"type":"list"}));
        assert_eq!(bad["error"]["code"], "unauthorized");
        assert!(state.requests.is_empty());
        for kind in [
            "ack",
            "shutdown",
            "bridgeEnable",
            "bridgeDisable",
            "bridgeStatus",
        ] {
            let reply = rpc(descriptor.port, &descriptor.token, json!({"type":kind}));
            assert_eq!(reply["error"]["code"], "forbidden", "{kind}");
        }
        assert!(state.requests.is_empty());
        let client =
            thread::spawn(move || rpc(descriptor.port, &descriptor.token, json!({"type":"hello"})));
        let call = state.requests.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(call.is_live());
        assert!(matches!(
            call.command,
            BridgeCommand::Native(Command::Hello)
        ));
        call.response
            .send(Reply::success(json!({"protocol":1})))
            .unwrap();
        assert_eq!(
            client.join().unwrap(),
            json!({"ok":true,"value":{"protocol":1}})
        );
    }

    #[test]
    fn disable_invalidates_already_queued_mutations() {
        let dir = TempDir::new();
        let mut state = BridgeState::new(dir.descriptor());
        state.enable().unwrap();
        let descriptor = read_descriptor(&dir.descriptor()).unwrap();
        let client = thread::spawn(move || {
            rpc(
                descriptor.port,
                &descriptor.token,
                json!({"type":"close","sessionId":"abc"}),
            )
        });
        let call = state.requests.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(call.is_live());
        state.disable();
        assert!(!call.is_live());
        call.response
            .send(Reply::error("unavailable", "Disabled"))
            .unwrap();
        assert_eq!(client.join().unwrap()["error"]["code"], "unavailable");
    }

    #[test]
    fn live_descriptor_cannot_be_overwritten_and_dead_one_is_reclaimed() {
        let dir = TempDir::new();
        let mut first = BridgeState::new(dir.descriptor());
        let mut second = BridgeState::new(dir.descriptor());
        first.enable().unwrap();
        let token = read_descriptor(&dir.descriptor()).unwrap().token;
        assert!(second.enable().is_err());
        assert_eq!(read_descriptor(&dir.descriptor()).unwrap().token, token);
        first.disable();
        let unused = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = unused.local_addr().unwrap().port();
        drop(unused);
        write_descriptor(
            &dir.descriptor(),
            &Descriptor {
                protocol: 1,
                port,
                token,
                pid: 1,
            },
        )
        .unwrap();
        second.enable().unwrap();
        assert_eq!(second.status()["enabled"], true);
    }

    #[test]
    fn uncertain_connection_failure_preserves_existing_credentials() {
        let dir = TempDir::new();
        let descriptor = Descriptor {
            protocol: 1,
            port: 12345,
            token: "a".repeat(64),
            pid: 1,
        };
        write_descriptor(&dir.descriptor(), &descriptor).unwrap();
        let original = fs::read(dir.descriptor()).unwrap();
        for kind in [io::ErrorKind::TimedOut, io::ErrorKind::PermissionDenied] {
            let error = reclaim_stale_descriptor_with_connect(&dir.descriptor(), |_, _| {
                Err(io::Error::new(kind, "injected ambiguous probe failure"))
            })
            .unwrap_err();
            assert_eq!(error.downcast_ref::<io::Error>().unwrap().kind(), kind);
            assert_eq!(fs::read(dir.descriptor()).unwrap(), original);
        }
    }

    #[test]
    fn read_offsets_are_raw_binary_bounded_and_report_overrun() {
        let mut history = OutputHistory::default();
        let empty = ReadOptions {
            session_id: "test".into(),
            cursor: 0,
            max_bytes: MAX_READ_BYTES,
        };
        assert_eq!(history.read(&empty).unwrap()["data"], "");
        let bytes: Vec<u8> = (0..HISTORY_BYTES + 17).map(|n| n as u8).collect();
        history.append(&bytes, bytes.len() as u64);
        let first = history.read(&empty).unwrap();
        assert_eq!(first["oldestCursor"], 17);
        assert_eq!(first["cursor"], 17 + MAX_READ_BYTES);
        assert_eq!(first["endCursor"], bytes.len());
        assert_eq!(first["truncated"], true);
        assert_eq!(first["exited"], false);
        assert_eq!(
            STANDARD.decode(first["data"].as_str().unwrap()).unwrap(),
            bytes[17..17 + MAX_READ_BYTES]
        );
        let invalid = ReadOptions {
            cursor: bytes.len() as u64 + 1,
            ..empty
        };
        assert!(history.read(&invalid).is_err());
        let tail = ReadOptions {
            cursor: bytes.len() as u64,
            ..invalid
        };
        history.exited = true;
        history.exit_code = Some(7);
        let final_read = history.read(&tail).unwrap();
        assert_eq!(final_read["data"], "");
        assert_eq!(final_read["exited"], true);
        assert_eq!(final_read["exitCode"], 7);
    }
}
