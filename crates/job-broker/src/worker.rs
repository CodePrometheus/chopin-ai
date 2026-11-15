use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::{
    Caller, Credential, Error, ExitStatus, JobId, ProcessIdentity, Request, Result, Settings,
};

/// Independently resolved endpoint for one immutable worker reservation.
#[derive(Clone)]
pub struct WorkerEndpoint {
    url: Url,
    credential: Credential,
    worker: Uuid,
}
impl WorkerEndpoint {
    /// Validates an explicit transport address without embedding bearer material in it.
    pub fn new(url: &str, credential: Credential, worker: Uuid) -> Result<Self> {
        if worker.is_nil() {
            return Err(Error::Invalid);
        }
        Ok(Self {
            url: address(url)?,
            credential,
            worker,
        })
    }
    /// Authenticated worker identity expected in every response.
    pub fn worker(&self) -> Uuid {
        self.worker
    }
    /// Base address supplied by the trusted directory.
    pub fn url(&self) -> &Url {
        &self.url
    }
    /// Endpoint-specific bearer; it is separate from the callback's credential.
    pub fn credential(&self) -> &Credential {
        &self.credential
    }
}
impl std::fmt::Debug for WorkerEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerEndpoint")
            .field("worker", &self.worker)
            .finish_non_exhaustive()
    }
}

/// Purpose-bound callback for the original operation and worker.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Callback {
    /// Absolute callback endpoint, kept separate from its credential.
    pub url: String,
    /// Original-operation callback authority, not new-work authority.
    pub credential: Credential,
}
impl std::fmt::Debug for Callback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Callback([redacted])")
    }
}

/// Immutable worker admission, persisted by the worker before it creates a gated process.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerStart {
    /// Supported worker transport version.
    pub version: u32,
    /// Original stable command identity; duplicates must never create another process.
    pub id: JobId,
    /// Original immutable command.
    pub request: Request,
    /// Host policy pinned when this operation was admitted.
    pub settings: Settings,
    /// Original worker's authenticated control channel.
    pub callback: Callback,
}
impl WorkerStart {
    /// Validate the wire representation without granting authority over host resources.
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 || self.id.scope.is_nil() || self.id.operation.is_nil() {
            return Err(Error::Invalid);
        }
        self.request.validate()?;
        self.settings.validate()?;
        address(&self.callback.url)?;
        Ok(())
    }
}

/// An authenticated observation of one exact original operation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerObservation {
    /// Original operation whose state was actually observed.
    pub id: JobId,
    /// Independently verified worker identity.
    pub worker: Uuid,
    /// Observed physical facts. Failed observations return an error instead.
    pub state: WorkerState,
}

/// Positive worker observations; unknown outcomes are transport errors, never absence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkerState {
    /// Durable admission receipt carrying no new physical observation.
    Accepted,
    /// The original process exists behind the release gate.
    Attached {
        /// Independently observed original identity.
        process: ProcessIdentity,
    },
    /// The original process passed the release gate.
    Running {
        /// Same identity registered before release.
        process: ProcessIdentity,
    },
    /// The original process namespace drained and its output stream ended.
    Drained {
        /// Identity independently verified as drained.
        process: ProcessIdentity,
        /// Primary process result.
        exit: ExitStatus,
        /// Final worker output sequence, which may still need delivery to the broker.
        sequence: u64,
    },
    /// Durable tombstone prevents command execution for this identity, including late starts.
    Cancelled,
}

/// Authenticated lookup reply; an HTTP status alone cannot prove absence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkerLookup {
    /// This exact worker independently verified that this operation was never admitted.
    Absent {
        /// Original queried operation.
        id: JobId,
        /// Verified worker identity.
        worker: Uuid,
    },
    /// Durable admission or physical observation of the exact original operation.
    Found {
        /// Identity-bound worker result.
        observation: WorkerObservation,
    },
}

/// Host-owned directory resolves a protection domain without starting command execution.
#[async_trait::async_trait]
pub trait WorkerDirectory: Send + Sync {
    /// Resolve the original worker, or the published worker for a new reservation.
    async fn locate(
        &self,
        caller: &Caller,
        request: &Request,
        expected: Option<Uuid>,
    ) -> Result<WorkerEndpoint>;
}

/// Worker placement and original-operation transport supplied by a trusted host.
#[async_trait::async_trait]
pub trait WorkerTransport: Send + Sync {
    /// Resolve the original protection domain; `expected` must never silently select another worker.
    async fn locate(
        &self,
        caller: &Caller,
        request: &Request,
        expected: Option<Uuid>,
    ) -> Result<WorkerEndpoint>;
    /// Admit this stable identity once, durably, before spawning. Repeats reconcile the same process.
    async fn start(
        &self,
        endpoint: &WorkerEndpoint,
        launch: &WorkerStart,
    ) -> Result<WorkerObservation>;
    /// `None` proves this operation was never admitted on this worker; failures return an error.
    /// Lost worker storage or an unknown previous process must never be reported as `None`.
    async fn observe(
        &self,
        endpoint: &WorkerEndpoint,
        id: JobId,
    ) -> Result<Option<WorkerObservation>>;
    /// Persist stop for the original identity, including an absent operation, before acknowledging.
    async fn stop(&self, endpoint: &WorkerEndpoint, id: JobId) -> Result<WorkerObservation>;
}

pub(crate) fn address(value: &str) -> Result<Url> {
    let mut url = Url::parse(value).map_err(|_| Error::Invalid)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Invalid);
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}
