//! Reusable native PTY session engine. No browser, socket or Chrome dependency.
//!
//! The caller consumes [`PtyEvent`] and acknowledges raw output offsets after
//! rendering. Readers stop at the credit window; writers have a bounded queue
//! so a program that stops reading stdin cannot block unrelated sessions.

mod flow;
mod io;
pub mod shells;

use anyhow::{anyhow, bail, Context, Result};
use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use flow::FlowControl;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use terminal_protocol::{
    CreateOptions, SessionInfo, MAX_INPUT_BYTES, MAX_SESSIONS, OUTPUT_CHUNK_BYTES,
};

/// Ordered output events. `Exit` is queued only after all readable output.
#[derive(Debug)]
pub enum PtyEvent {
    Output {
        session_id: String,
        data: Vec<u8>,
        seq: u64,
    },
    Exit {
        session_id: String,
        exit_code: u32,
    },
}

struct Process {
    child: Box<dyn Child + Send + Sync>,
    status: Option<u32>,
}

type SharedMaster = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

struct Session {
    info: Arc<Mutex<SessionInfo>>,
    master: SharedMaster,
    process: Arc<Mutex<Process>>,
    flow: Arc<FlowControl>,
    input: Option<Sender<Vec<u8>>>,
    /// Disconnecting this channel broadcasts cancellation to all worker clones.
    cancel: Option<Sender<()>>,
}

impl Session {
    fn stop(&mut self) {
        self.flow.close();
        self.cancel.take();
        self.input.take();
        // Hold the child lock through status-check + signal. The monitor cannot
        // reap the process concurrently, so its PID cannot be recycled here.
        let mut process = self.process.lock().unwrap();
        if process.status.is_none() {
            if let Ok(Some(status)) = process.child.try_wait() {
                process.status = Some(status.exit_code());
            } else {
                #[cfg(unix)]
                if let Some(master) = self.master.lock().unwrap().as_ref() {
                    let shell_group = process
                        .child
                        .process_id()
                        .and_then(|pid| i32::try_from(pid).ok());
                    let foreground_group = master.process_group_leader();
                    // Shells use a separate process group for foreground jobs.
                    // Kill both the shell group and current foreground group.
                    // Deliberately detached daemons retain normal shell semantics.
                    for group in [foreground_group, shell_group].into_iter().flatten() {
                        if group > 1 {
                            // SAFETY: group is a positive PTY-owned process group;
                            // negative pid targets it, never our own process group.
                            unsafe {
                                libc::kill(-group, libc::SIGHUP);
                            }
                        }
                    }
                    if let Some(group) =
                        foreground_group.filter(|g| *g > 1 && Some(*g) != shell_group)
                    {
                        // A foreground process that ignores HUP must not retain
                        // the PTY handles and strand the output reader forever.
                        unsafe {
                            libc::kill(-group, libc::SIGKILL);
                        }
                    }
                }
                #[cfg(unix)]
                // Darwin's slave close waits for queued output to drain, even
                // while a killed process is exiting. The reader was cancelled
                // above, so retaining this master until after wait() deadlocks
                // a saturated terminal. Release it now: cancelled reader/writer
                // clones close within their poll deadline, and the final master
                // hangup flushes the queue and lets the child finish exiting.
                release_master(&self.master);
                let _ = process.child.kill();
                // portable-pty's concrete Child::kill guarantees eventual
                // termination (including Unix escalation); reap to avoid zombies.
                if let Ok(status) = process.child.wait() {
                    process.status = Some(status.exit_code());
                }
            }
        }
        drop(process);
        release_master(&self.master);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

fn release_master(master: &SharedMaster) {
    let master = master.lock().unwrap().take();
    #[cfg(windows)]
    if let Some(master) = master {
        // ClosePseudoConsole can synchronously flush final output. The reader
        // must keep draining concurrently; never block the host command loop.
        thread::spawn(move || drop(master));
    }
    #[cfg(not(windows))]
    drop(master);
}

pub struct SessionManager {
    sessions: BTreeMap<String, Session>,
    events: Sender<PtyEvent>,
}

impl SessionManager {
    /// The receiver must be drained by the caller. All output queues are bounded.
    pub fn new() -> (Self, Receiver<PtyEvent>) {
        let (events, receiver) = bounded(64);
        (
            Self {
                sessions: BTreeMap::new(),
                events,
            },
            receiver,
        )
    }

    pub fn create(&mut self, options: CreateOptions) -> Result<SessionInfo> {
        options.validate().map_err(|error| anyhow!(error))?;
        if self.sessions.len() >= MAX_SESSIONS {
            bail!("Maximum of {MAX_SESSIONS} sessions reached; close an existing session first");
        }
        let requested_shell = options.shell.unwrap_or_else(shells::default_shell);
        let shell = shells::find_executable(&requested_shell)
            .with_context(|| format!("Shell executable not found: {requested_shell}"))?
            .to_string_lossy()
            .into_owned();
        let args = options
            .args
            .unwrap_or_else(|| shells::default_arguments(&shell));
        let home = shells::home_directory();
        let cwd = match options.cwd.as_deref().filter(|v| !v.is_empty()) {
            None | Some("~") => home,
            Some(value) if value.starts_with("~/") || value.starts_with("~\\") => {
                home.join(&value[2..])
            }
            Some(value) => PathBuf::from(value),
        };
        if !cwd.is_absolute() {
            bail!("Working directory must be absolute or start with ~/");
        }
        if !cwd.is_dir() {
            bail!(
                "Working directory does not exist or is not a directory: {}",
                cwd.display()
            );
        }
        let id = uuid::Uuid::new_v4().to_string();
        let title = options
            .title
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| {
                PathBuf::from(&shell)
                    .file_stem()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Terminal".into())
            });
        let pair = native_pty_system()
            .openpty(PtySize {
                cols: options.cols,
                rows: options.rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Could not allocate a native pseudo-terminal")?;
        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(&args);
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "HostTerminal");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        for (key, value) in &options.env {
            cmd.env(key, value);
        }
        // Take handles before spawning: on acquisition failure no child needs
        // cleanup and no half-initialized session can escape.
        let (cancel, cancel_rx) = bounded(0);
        let (reader, writer) =
            io::open(pair.master.as_ref(), cancel_rx.clone()).context("Could not open PTY IO")?;
        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("Could not launch {shell}"))?;
        drop(pair.slave);
        let info = SessionInfo {
            id: id.clone(),
            title,
            shell,
            args,
            cwd: cwd.to_string_lossy().into_owned(),
            cols: options.cols,
            rows: options.rows,
            pid: child.process_id(),
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            exited: false,
            exit_code: None,
        };
        let info_shared = Arc::new(Mutex::new(info.clone()));
        let process = Arc::new(Mutex::new(Process {
            child,
            status: None,
        }));
        let flow = Arc::new(FlowControl::default());
        let (input, input_rx) = bounded(8);
        let (read_done, read_done_rx) = bounded(1);
        let master = Arc::new(Mutex::new(Some(pair.master)));
        let session = Session {
            info: info_shared.clone(),
            master: master.clone(),
            process: process.clone(),
            flow: flow.clone(),
            input: Some(input),
            cancel: Some(cancel),
        };
        // Session RAII now owns the spawned child. A thread-creation failure drops
        // it and terminates the process; successful workers receive cancellation.
        if let Err(error) = spawn_reader(
            id.clone(),
            reader,
            flow.clone(),
            self.events.clone(),
            cancel_rx.clone(),
            read_done,
        ) {
            // Session::drop may have to reap a Darwin child blocked in ttywait.
            // Do not keep an unstarted writer's master clone alive across it.
            drop(writer);
            return Err(error);
        }
        spawn_writer(writer, input_rx, cancel_rx.clone())?;
        spawn_monitor(
            id.clone(),
            process,
            info_shared,
            master,
            self.events.clone(),
            cancel_rx,
            read_done_rx,
        )?;
        self.sessions.insert(id, session);
        Ok(info)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .values()
            .map(|session| session.info.lock().unwrap().clone())
            .collect()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    pub fn input(&self, id: &str, bytes: Vec<u8>) -> Result<()> {
        if bytes.len() > MAX_INPUT_BYTES {
            bail!("Input exceeds 64 KiB");
        }
        let session = self.sessions.get(id).context("Session not found")?;
        // Keep the pipe available until it closes: a terminal device reply
        // (for example ConPTY's cursor-position query) can be required while
        // final output is draining after the shell process has already exited.
        let sender = session.input.as_ref().context("Session is closed")?;
        match sender.try_send(bytes) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                bail!("Terminal input is busy; wait for the program to read input")
            }
            Err(TrySendError::Disconnected(_)) => bail!("PTY input is closed"),
        }
    }

    pub fn resize(&mut self, id: &str, cols: u16, rows: u16) -> Result<()> {
        terminal_protocol::validate_size(cols, rows).map_err(|error| anyhow!(error))?;
        let session = self.sessions.get_mut(id).context("Session not found")?;
        session
            .master
            .lock()
            .unwrap()
            .as_ref()
            .context("Session is closed")?
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        let mut info = session.info.lock().unwrap();
        info.cols = cols;
        info.rows = rows;
        Ok(())
    }

    pub fn rename(&mut self, id: &str, title: String) -> Result<()> {
        terminal_protocol::validate_title(&title).map_err(|error| anyhow!(error))?;
        self.sessions
            .get(id)
            .context("Session not found")?
            .info
            .lock()
            .unwrap()
            .title = title;
        Ok(())
    }

    pub fn acknowledge(&self, id: &str, seq: u64) -> Result<()> {
        self.sessions
            .get(id)
            .context("Session not found")?
            .flow
            .acknowledge(seq)
    }

    pub fn close(&mut self, id: &str) -> Result<()> {
        let mut session = self.sessions.remove(id).context("Session not found")?;
        session.stop();
        Ok(())
    }

    pub fn shutdown(&mut self) {
        self.sessions.clear();
    }
}

fn spawn_reader(
    id: String,
    mut reader: Box<dyn Read + Send>,
    flow: Arc<FlowControl>,
    events: Sender<PtyEvent>,
    cancel: Receiver<()>,
    done: Sender<()>,
) -> Result<()> {
    thread::Builder::new()
        .name(format!("pty-read-{}", &id[..8]))
        .spawn(move || {
            let mut buffer = [0_u8; OUTPUT_CHUNK_BYTES];
            while let Some(allowance) = flow.allowance() {
                let count = match reader.read(&mut buffer[..allowance]) {
                    Ok(0) => break,
                    Ok(count) => count,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                let Some(seq) = flow.produced(count) else {
                    break;
                };
                let event = PtyEvent::Output {
                    session_id: id.clone(),
                    data: buffer[..count].to_vec(),
                    seq,
                };
                crossbeam_channel::select! {
                    send(events, event) -> result => if result.is_err() { break; },
                    recv(cancel) -> _ => break,
                }
            }
            #[cfg(windows)]
            {
                // When cancelled, discard remaining bytes until ConPTY closes
                // its pipe. Leaving the pipe unread can deadlock its destructor.
                let _ = std::io::copy(&mut reader, &mut std::io::sink());
            }
            let _ = done.send(());
        })
        .context("Could not start PTY output thread")?;
    Ok(())
}

fn spawn_writer(
    mut writer: Box<dyn Write + Send>,
    input: Receiver<Vec<u8>>,
    cancel: Receiver<()>,
) -> Result<()> {
    thread::Builder::new().name("pty-input".into()).spawn(move || loop {
        crossbeam_channel::select! {
            recv(cancel) -> _ => break,
            recv(input) -> value => match value {
                Ok(bytes) => if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() { break; },
                Err(_) => break,
            }
        }
    }).context("Could not start PTY input thread")?;
    Ok(())
}

fn spawn_monitor(
    id: String,
    process: Arc<Mutex<Process>>,
    info: Arc<Mutex<SessionInfo>>,
    master: SharedMaster,
    events: Sender<PtyEvent>,
    cancel: Receiver<()>,
    read_done: Receiver<()>,
) -> Result<()> {
    thread::Builder::new()
        .name(format!("pty-wait-{}", &id[..8]))
        .spawn(move || {
            let exit_code = loop {
                let result = {
                    let mut process = process.lock().unwrap();
                    if let Some(code) = process.status {
                        Ok(Some(code))
                    } else {
                        process.child.try_wait().map(|status| {
                            status.map(|s| {
                                let code = s.exit_code();
                                process.status = Some(code);
                                code
                            })
                        })
                    }
                };
                match result {
                    Ok(Some(code)) => break code,
                    Ok(None) => {}
                    Err(_) => break 1,
                }
                crossbeam_channel::select! {
                    recv(cancel) -> _ => return,
                    default(Duration::from_millis(25)) => {},
                }
            };
            {
                let mut meta = info.lock().unwrap();
                meta.exited = true;
                meta.exit_code = Some(exit_code);
            }
            // On Windows EOF is produced by closing the pseudoconsole itself,
            // not necessarily by the last child exiting. Release it before
            // waiting for read_done so exit delivery cannot wait on itself.
            release_master(&master);
            // read_done follows every output send; the main thread will observe all
            // output before Exit, even if the subprocess exited in a single syscall.
            crossbeam_channel::select! {
                recv(cancel) -> _ => return,
                recv(read_done) -> _ => {},
            }
            crossbeam_channel::select! {
                recv(cancel) -> _ => {},
                send(events, PtyEvent::Exit {session_id:id, exit_code}) -> _ => {},
            }
        })
        .context("Could not start PTY wait thread")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use terminal_protocol::OUTPUT_WINDOW_BYTES;

    #[test]
    #[cfg(windows)]
    fn conpty_delivers_output_and_natural_exit_without_explicit_close() {
        let (mut manager, events) = SessionManager::new();
        let session = manager
            .create(CreateOptions {
                shell: Some(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())),
                args: Some(vec![
                    "/D".into(),
                    "/Q".into(),
                    "/C".into(),
                    "echo WINDOWS_PTY_READY & exit /b 7".into(),
                ]),
                cwd: None,
                env: BTreeMap::new(),
                title: None,
                cols: 80,
                rows: 24,
            })
            .unwrap();
        let mut output = Vec::new();
        loop {
            match events.recv_timeout(Duration::from_secs(15)).unwrap() {
                PtyEvent::Output { data, seq, .. } => {
                    output.extend(data);
                    manager.acknowledge(&session.id, seq).unwrap();
                    // ConPTY cursor-inheritance mode can query cursor position.
                    if output.windows(4).any(|window| window == b"\x1b[6n") {
                        let _ = manager.input(&session.id, b"\x1b[1;1R".to_vec());
                    }
                }
                PtyEvent::Exit { exit_code, .. } => {
                    assert_eq!(exit_code, 7);
                    break;
                }
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("WINDOWS_PTY_READY"));
        manager.close(&session.id).unwrap();
    }

    #[cfg(unix)]
    fn shell_options(script: &str) -> CreateOptions {
        CreateOptions {
            shell: Some("/bin/sh".into()),
            args: Some(vec!["-c".into(), script.into()]),
            cwd: None,
            env: BTreeMap::new(),
            title: Some("test".into()),
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    #[cfg(unix)]
    fn pty_preserves_raw_bytes_and_exit_follows_last_output() {
        let (mut manager, events) = SessionManager::new();
        let session = manager
            .create(shell_options("printf '\\377\\000\\342\\202\\254'; exit 7"))
            .unwrap();
        let mut actual = Vec::new();
        loop {
            match events.recv_timeout(Duration::from_secs(5)).unwrap() {
                PtyEvent::Output {
                    session_id,
                    data,
                    seq,
                } => {
                    assert_eq!(session_id, session.id);
                    actual.extend(data);
                    manager.acknowledge(&session.id, seq).unwrap();
                }
                PtyEvent::Exit { exit_code, .. } => {
                    assert_eq!(exit_code, 7);
                    break;
                }
            }
        }
        assert_eq!(actual, vec![255, 0, 0xe2, 0x82, 0xac]);
        assert!(manager.list()[0].exited);
        manager.close(&session.id).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn input_and_resize_are_delivered_to_real_tty() {
        let (mut manager, events) = SessionManager::new();
        let session = manager
            .create(shell_options(
                "stty -echo; printf READY; read value; stty size; printf 'VALUE=%s' \"$value\"",
            ))
            .unwrap();
        let mut output = Vec::new();
        let mut sent = false;
        loop {
            match events.recv_timeout(Duration::from_secs(5)).unwrap() {
                PtyEvent::Output { data, seq, .. } => {
                    output.extend(data);
                    manager.acknowledge(&session.id, seq).unwrap();
                    if !sent && String::from_utf8_lossy(&output).contains("READY") {
                        manager.resize(&session.id, 132, 43).unwrap();
                        manager
                            .input(&session.id, b"native-input\n".to_vec())
                            .unwrap();
                        sent = true;
                    }
                }
                PtyEvent::Exit { exit_code, .. } => {
                    assert_eq!(exit_code, 0);
                    break;
                }
            }
        }
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("43 132"), "{text:?}");
        assert!(text.contains("VALUE=native-input"), "{text:?}");
    }

    #[test]
    #[cfg(unix)]
    fn output_flood_stops_at_credit_window_and_close_does_not_hang() {
        let (mut manager, events) = SessionManager::new();
        let session = manager.create(shell_options("exec yes flood")).unwrap();
        eprintln!("flood: started child {:?}", session.pid);
        let mut total = 0;
        while total < OUTPUT_WINDOW_BYTES {
            match events.recv_timeout(Duration::from_secs(5)).unwrap() {
                PtyEvent::Output { data, .. } => total += data.len(),
                _ => panic!("Unexpected exit"),
            }
        }
        eprintln!("flood: reached {total} bytes without acknowledgement");
        assert_eq!(total, OUTPUT_WINDOW_BYTES);
        assert!(events.recv_timeout(Duration::from_millis(50)).is_err());
        eprintln!("flood: closing saturated session");
        let (closed, completed) = bounded(1);
        let id = session.id.clone();
        let worker = thread::spawn(move || {
            let result = manager.close(&id);
            let _ = closed.send((result, manager));
        });
        let (result, manager) = completed
            .recv_timeout(Duration::from_secs(2))
            .expect("closing a saturated PTY did not finish within two seconds");
        result.unwrap();
        worker.join().unwrap();
        eprintln!("flood: close completed and worker joined");
        assert!(manager.list().is_empty());
        // Closing must reap the child, not just move an indefinitely blocked
        // wait into a detached background task or leave a zombie behind.
        let mut status = 0;
        let waited =
            unsafe { libc::waitpid(session.pid.unwrap() as i32, &mut status, libc::WNOHANG) };
        assert_eq!(waited, -1, "closed child was still running or unreaped");
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
}
