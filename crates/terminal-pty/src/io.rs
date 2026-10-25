//! Cancellable Unix PTY IO. A child can retain the slave after its shell exits;
//! closing a session must still release all host-owned master descriptors.

use anyhow::Result;
use crossbeam_channel::Receiver;
use portable_pty::MasterPty;
use std::io::{Read, Write};

type PtyIo = (Box<dyn Read + Send>, Box<dyn Write + Send>);

#[cfg(not(unix))]
pub(crate) fn open(master: &dyn MasterPty, _cancel: Receiver<()>) -> Result<PtyIo> {
    Ok((master.try_clone_reader()?, master.take_writer()?))
}

#[cfg(unix)]
pub(crate) fn open(master: &dyn MasterPty, cancel: Receiver<()>) -> Result<PtyIo> {
    use std::os::fd::FromRawFd;
    let fd = master
        .as_raw_fd()
        .ok_or_else(|| anyhow::anyhow!("Native Unix PTY has no file descriptor"))?;
    // SAFETY: fd is borrowed from a live MasterPty and is not closed here.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(std::io::Error::last_os_error().into());
    }
    let duplicate = || -> Result<std::fs::File> {
        // SAFETY: F_DUPFD_CLOEXEC returns an independent descriptor owned by us;
        // after from_raw_fd, File is its sole owner and closes it exactly once.
        let owned = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        if owned == -1 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(unsafe { std::fs::File::from_raw_fd(owned) })
    };
    let reader = UnixIo {
        file: duplicate()?,
        cancel: cancel.clone(),
    };
    let writer = UnixIo {
        file: duplicate()?,
        cancel,
    };
    Ok((Box::new(reader), Box::new(writer)))
}

#[cfg(unix)]
struct UnixIo {
    file: std::fs::File,
    cancel: Receiver<()>,
}

#[cfg(unix)]
impl UnixIo {
    fn ready(&self, event: libc::c_short) -> std::io::Result<bool> {
        use std::os::fd::AsRawFd;
        loop {
            if !matches!(
                self.cancel.try_recv(),
                Err(crossbeam_channel::TryRecvError::Empty)
            ) {
                return Ok(false);
            }
            let mut descriptor = libc::pollfd {
                fd: self.file.as_raw_fd(),
                events: event,
                revents: 0,
            };
            // Cancellation is bounded by 100 ms without a separate wakeup FD.
            // Output arrival wakes poll immediately; this adds no output latency.
            // SAFETY: descriptor references our owned live File throughout poll.
            let ready = unsafe { libc::poll(&mut descriptor, 1, 100) };
            if ready > 0 {
                if descriptor.revents & libc::POLLNVAL != 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "PTY descriptor closed",
                    ));
                }
                return Ok(true);
            }
            if ready == -1 {
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }
}

#[cfg(unix)]
impl Read for UnixIo {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        while self.ready(libc::POLLIN)? {
            match self.file.read(buffer) {
                Err(error) if error.raw_os_error() == Some(libc::EIO) => return Ok(0),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue
                }
                result => return result,
            }
        }
        Ok(0)
    }
}

#[cfg(unix)]
impl Write for UnixIo {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        while self.ready(libc::POLLOUT)? {
            match self.file.write(buffer) {
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue
                }
                result => return result,
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "PTY session closed",
        ))
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crossbeam_channel::bounded;
    use portable_pty::{native_pty_system, PtySize};
    use std::time::{Duration, Instant};

    #[test]
    fn cancellation_unblocks_reader_even_when_slave_still_open() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let (stop, cancelled) = bounded(0);
        let (mut reader, _writer) = open(pair.master.as_ref(), cancelled).unwrap();
        let worker = std::thread::spawn(move || reader.read(&mut [0; 16]));
        let start = Instant::now();
        drop(stop);
        assert_eq!(worker.join().unwrap().unwrap(), 0);
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(pair.slave);
    }

    #[test]
    fn cancellation_unblocks_writer_when_slave_does_not_read() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        // Canonical mode may accept and discard a long unterminated line, so
        // it cannot prove that the writer is blocked. Raw mode preserves bytes
        // and creates real backpressure when the slave is deliberately unread.
        let descriptor = pair.master.as_raw_fd().unwrap();
        let mut attributes = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: descriptor remains owned by pair, and tcgetattr initializes
        // attributes on success before we access it.
        assert_eq!(
            unsafe { libc::tcgetattr(descriptor, attributes.as_mut_ptr()) },
            0
        );
        let mut attributes = unsafe { attributes.assume_init() };
        // SAFETY: attributes is initialized and descriptor is a live PTY.
        unsafe { libc::cfmakeraw(&mut attributes) };
        assert_eq!(
            unsafe { libc::tcsetattr(descriptor, libc::TCSANOW, &attributes) },
            0
        );
        let (stop, cancelled) = bounded(0);
        let (_reader, mut writer) = open(pair.master.as_ref(), cancelled).unwrap();
        let (ready_tx, ready_rx) = bounded(1);
        let (done_tx, done_rx) = bounded(1);
        let worker = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            let result = writer.write_all(&vec![b'x'; 1024 * 1024]);
            done_tx.send(result).unwrap();
        });
        ready_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(30));
        assert!(
            done_rx.try_recv().is_err(),
            "Unread raw PTY should apply backpressure"
        );
        let start = Instant::now();
        drop(stop);
        assert!(done_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_err());
        worker.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(pair.slave);
    }
}
