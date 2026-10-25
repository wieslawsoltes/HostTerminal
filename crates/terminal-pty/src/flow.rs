use anyhow::{bail, Result};
use std::sync::{Condvar, Mutex};
use terminal_protocol::{OUTPUT_CHUNK_BYTES, OUTPUT_WINDOW_BYTES};

#[derive(Default)]
struct State {
    produced: u64,
    acknowledged: u64,
    closed: bool,
}

/// Cumulative byte offsets make duplicate acknowledgements harmless. A reader
/// reserves at most the remaining credit *before* reading from the kernel.
/// This bounds memory even when the renderer stops consuming output.
#[derive(Default)]
pub(crate) struct FlowControl {
    state: Mutex<State>,
    changed: Condvar,
}

impl FlowControl {
    pub fn allowance(&self) -> Option<usize> {
        let mut state = self.state.lock().unwrap();
        while !state.closed && state.produced - state.acknowledged >= OUTPUT_WINDOW_BYTES as u64 {
            state = self.changed.wait(state).unwrap();
        }
        if state.closed {
            return None;
        }
        Some(
            (OUTPUT_WINDOW_BYTES - (state.produced - state.acknowledged) as usize)
                .min(OUTPUT_CHUNK_BYTES),
        )
    }

    pub fn produced(&self, bytes: usize) -> Option<u64> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return None;
        }
        state.produced += bytes as u64;
        Some(state.produced)
    }

    pub fn acknowledge(&self, seq: u64) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if seq > state.produced {
            bail!("Acknowledgement exceeds bytes emitted");
        }
        if seq > state.acknowledged {
            state.acknowledged = seq;
            self.changed.notify_all();
        }
        Ok(())
    }

    pub fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[test]
    fn window_blocks_until_consumption_and_duplicate_ack_cannot_mint_credit() {
        let flow = Arc::new(FlowControl::default());
        for _ in 0..OUTPUT_WINDOW_BYTES / OUTPUT_CHUNK_BYTES {
            assert_eq!(flow.allowance(), Some(OUTPUT_CHUNK_BYTES));
            flow.produced(OUTPUT_CHUNK_BYTES).unwrap();
        }
        let other = flow.clone();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || tx.send(other.allowance()).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        assert!(flow.acknowledge(OUTPUT_WINDOW_BYTES as u64 + 1).is_err());
        flow.acknowledge(100).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), Some(100));
        worker.join().unwrap();
        flow.acknowledge(100).unwrap();
        flow.acknowledge(50).unwrap();
        assert_eq!(flow.allowance(), Some(100));
    }

    #[test]
    fn cancellation_wakes_a_saturated_reader() {
        let flow = Arc::new(FlowControl::default());
        flow.produced(OUTPUT_WINDOW_BYTES).unwrap();
        let other = flow.clone();
        let worker = std::thread::spawn(move || other.allowance());
        flow.close();
        assert_eq!(worker.join().unwrap(), None);
    }
}
