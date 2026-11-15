use serde::{Deserialize, Serialize};

use crate::{Error, Result, Stream, WorkerEvent};

/// Explicit host policy retained with each admitted operation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    /// Supported policy representation version.
    pub version: u32,
    /// Published policy revision adopted for new operations.
    pub revision: String,
    /// Polling guidance returned to callers, in milliseconds.
    pub poll_after_ms: u64,
    /// Recovery cadence chosen by the host, in milliseconds.
    pub recovery_interval_ms: u64,
    /// Deadline for one external worker request, in milliseconds.
    pub request_timeout_ms: u64,
    /// Maximum original bytes per output frame.
    pub frame_bytes: usize,
    /// Maximum original bytes returned by one output page.
    pub output_page_bytes: usize,
    /// Maximum encoded request body accepted for this operation.
    pub max_body_bytes: usize,
}

impl Settings {
    /// Refuses incomplete policy and output frames that cannot fit its body bound.
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.revision.is_empty()
            || self.poll_after_ms == 0
            || self.recovery_interval_ms == 0
            || self.request_timeout_ms == 0
            || self.frame_bytes == 0
            || self.output_page_bytes == 0
            || self.max_body_bytes == 0
        {
            return Err(Error::Invalid);
        }
        let encoded = (self.frame_bytes / 3)
            .checked_mul(4)
            .and_then(|full| {
                full.checked_add(match self.frame_bytes % 3 {
                    0 => 0,
                    1 => 2,
                    _ => 3,
                })
            })
            .ok_or(Error::Invalid)?;
        let header = serde_json::to_vec(&WorkerEvent::Output {
            sequence: u64::MAX,
            stream: Stream::Stderr,
            data: String::new(),
        })?
        .len();
        if encoded
            .checked_add(header)
            .is_none_or(|size| size > self.max_body_bytes)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

/// Whether the first intent admits work or records cancellation before it can start.
#[derive(Clone, Copy, Debug)]
pub enum Admission<'a> {
    /// Store a new command under this published host policy.
    Execute(&'a Settings),
    /// Store a cancellation tombstone under this policy without admitting execution.
    Cancel(&'a Settings),
}
