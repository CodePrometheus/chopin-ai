use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{Error, Result};

/// Identity of one immutable command within a logical agent's scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobId {
    /// Logical owner scope, independent of the active runtime generation.
    pub scope: Uuid,
    /// Stable client-chosen identity persisted before sending the command.
    pub operation: Uuid,
}

/// The generation-bound execution caller authenticated by the host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Caller {
    /// Logical agent scope containing the operation.
    pub scope: Uuid,
    /// Original physical allocation's protection domain.
    pub domain: Uuid,
    /// Current host-issued runtime allocation.
    pub runtime: Uuid,
    /// Current independently admitted writer generation.
    pub generation: u64,
    /// Execution-store owner identity, supplied by the authenticator.
    pub owner: String,
}

/// A worker callback identity; it does not authorize a new command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerCaller {
    /// Original execution caller whose command this worker owns.
    pub caller: Caller,
    /// Exact original operation.
    pub operation: Uuid,
    /// Immutable worker reservation.
    pub worker: Uuid,
}

/// Purpose-bound bearer material, redacted in diagnostics and zeroized on drop.
#[derive(Clone, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(transparent)]
pub struct Credential(String);

impl PartialEq for Credential {
    fn eq(&self, other: &Self) -> bool {
        bool::from(self.0.as_bytes().ct_eq(other.0.as_bytes()))
    }
}
impl Eq for Credential {}

impl Credential {
    /// Validates a bearer value without storing it in a URL or diagnostic.
    pub fn new(value: String) -> Result<Self> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err(Error::Invalid);
        }
        Ok(Self(value))
    }

    /// Exposes the value only at the authenticated transport boundary.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Credential([redacted])")
    }
}

impl<'de> Deserialize<'de> for Credential {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Exact delegated authority checked for both admission and release.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantReference {
    /// Host-issued delegation identity.
    pub id: Uuid,
    /// Immutable delegation revision adopted by the original work.
    pub version: u64,
}

/// Source of a command; evaluation work cannot inherit an ordinary tool's grant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Source {
    /// One original durable tool call.
    Tool {
        /// Execution-owned goal identity.
        goal_id: String,
        /// Conversation containing the call.
        conversation_id: u64,
        /// Durable task invoking the tool.
        task_id: u64,
        /// Original model or extension call identity.
        call_id: String,
    },
    /// Independently authorized improvement evaluation.
    Learning {
        /// Immutable evaluation run identity.
        run_id: Uuid,
    },
}

/// Immutable command content; equality is checked before every idempotent response.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    /// Supported command contract version.
    pub version: u32,
    /// Actual protection domain retained for reconciliation and stop.
    pub domain: Uuid,
    /// Original work that owns this effect.
    pub source: Source,
    /// Authority adopted by the original work.
    pub grant: GrantReference,
    /// Executable and arguments, interpreted only by the selected worker.
    pub argv: Vec<String>,
    /// Working directory checked by the host's resource policy.
    pub cwd: String,
    /// Explicit UTF-8 environment with nonempty names excluding `=` and NUL; values remain encrypted.
    pub env: BTreeMap<String, String>,
    /// Whether the published worker policy allows environment inheritance.
    pub inherit_env: bool,
    /// Optional host-approved command deadline, in milliseconds.
    pub timeout_ms: Option<u64>,
    /// Immutable execution policy reference, never a caller-supplied permission bypass.
    pub policy_revision: String,
}

impl std::fmt::Debug for Request {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Request")
            .field("version", &self.version)
            .field("domain", &self.domain)
            .finish_non_exhaustive()
    }
}

impl Request {
    /// Validates representation only; the host must check actual resources and authority.
    pub fn validate(&self) -> Result<()> {
        const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
        let source = match &self.source {
            Source::Tool {
                goal_id,
                conversation_id,
                task_id,
                call_id,
            } => {
                !goal_id.is_empty()
                    && !call_id.is_empty()
                    && (1..=MAX_SAFE_INTEGER).contains(conversation_id)
                    && (1..=MAX_SAFE_INTEGER).contains(task_id)
            }
            Source::Learning { run_id } => !run_id.is_nil(),
        };
        if self.version != 1
            || self.domain.is_nil()
            || self.grant.id.is_nil()
            || self.grant.version == 0
            || self.argv.first().is_none_or(String::is_empty)
            || self.argv.iter().any(|arg| arg.contains('\0'))
            || self.cwd.is_empty()
            || self.cwd.contains('\0')
            || self.policy_revision.is_empty()
            || self.timeout_ms == Some(0)
            || !source
            || !valid_environment(&self.env)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

pub(crate) fn valid_environment(env: &BTreeMap<String, String>) -> bool {
    env.iter().all(|(name, value)| {
        !name.is_empty() && !name.contains(['=', '\0']) && !value.contains('\0')
    })
}

/// Original operating-system identity, observed before the worker is released.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    /// Protection domain allocated for this command's original runtime.
    pub domain: Uuid,
    /// Kernel boot identity; a reused PID on another boot is not the same process.
    pub boot: Uuid,
    /// Host-visible process namespace leader identifier.
    pub init_pid: u32,
    /// Kernel start-time ticks distinguishing PID reuse.
    pub start_ticks: u64,
    /// Original process namespace inode.
    pub namespace_inode: u64,
}

/// An output channel; streams keep their original ordering in the ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    /// Standard output bytes.
    Stdout,
    /// Standard error bytes.
    Stderr,
}

/// The primary process result, independent of descendant drain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ExitStatus {
    /// Normal process exit code.
    Code(i32),
    /// Process terminated by this operating-system signal.
    Signal(i32),
}

/// Worker observations applied to the exact original reservation.
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkerEvent {
    /// Observe current control state without extending execution authority.
    Read,
    /// Record a process held behind the release gate.
    Attached {
        /// Independently observed original process identity.
        process: ProcessIdentity,
    },
    /// Request current authorization to release the recorded process.
    Release,
    /// Confirm the recorded process passed its release gate.
    Started,
    /// The worker durably barred command execution before any release attempt.
    NotStarted,
    /// Persist one immutable output frame before the worker drops its own copy.
    Output {
        /// Contiguous sequence beginning at one, shared by both output channels.
        sequence: u64,
        /// Original output channel.
        stream: Stream,
        /// URL-safe unpadded base64 of the original bytes.
        data: String,
    },
    /// Record the primary process result without claiming all descendants stopped.
    Exited {
        /// Observed primary process result.
        exit: ExitStatus,
    },
    /// No more output exists beyond the stated durable sequence.
    OutputComplete {
        /// Final output sequence, zero if no output exists.
        sequence: u64,
    },
    /// Confirm the exact original namespace has drained and all output is stored.
    Drained {
        /// Same identity recorded before release.
        process: ProcessIdentity,
        /// Final durable output sequence.
        sequence: u64,
    },
}

impl std::fmt::Debug for WorkerEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match self {
            Self::Read => "read",
            Self::Attached { .. } => "attached",
            Self::Release => "release",
            Self::Started => "started",
            Self::NotStarted => "not_started",
            Self::Output { .. } => "output",
            Self::Exited { .. } => "exited",
            Self::OutputComplete { .. } => "output_complete",
            Self::Drained { .. } => "drained",
        };
        f.debug_struct("WorkerEvent")
            .field("kind", &kind)
            .finish_non_exhaustive()
    }
}

/// Host authority checked inside the command's own transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Accept a new command with current execution authority.
    Submit,
    /// Read an original operation, including a previous runtime's operation.
    Read,
    /// Stop the original operation; this does not admit new execution.
    Stop,
}

/// Authority purpose of one worker callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerAction {
    /// Read or persist facts about the original command.
    Observe,
    /// Release the original process only with current execution authority.
    Release,
}

/// Host-owned identity and policy adapter; it joins the ledger transaction.
#[async_trait::async_trait]
pub trait HostAuthority: Send + Sync {
    /// Authenticate an execution credential without interpreting a worker credential as one.
    async fn authenticate(&self, credential: &str) -> Result<Caller>;
    /// Authenticate an exact worker callback identity.
    async fn authenticate_worker(&self, credential: &str) -> Result<WorkerCaller>;
    /// Validate current ownership of a whole scope without inventing a placeholder command.
    async fn authorize_scope(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        caller: &Caller,
    ) -> Result<()>;
    /// Validate current ownership and permission using the supplied transaction.
    async fn authorize(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        caller: &Caller,
        request: &Request,
        action: Action,
    ) -> Result<()>;
    /// Validate a callback's original binding and, for release, current execution permission.
    async fn authorize_worker(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        caller: &WorkerCaller,
        request: &Request,
        action: WorkerAction,
    ) -> Result<()>;
    /// Issue a purpose-bound callback credential after reserving its worker.
    fn worker_credential(&self, caller: &Caller, id: JobId, worker: Uuid) -> Result<Credential>;
}
