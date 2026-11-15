use std::{num::NonZeroUsize, sync::Arc};

use base64::{Engine as _, prelude::BASE64_URL_SAFE_NO_PAD};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::{
    Admission, Caller, Error, ExitStatus, JobId, ProcessIdentity, Request, Result, Settings,
    Stream, WorkerEvent,
};

/// Initial immutable ledger schema, applied in the host's migration transaction.
pub const SCHEMA_V1: &str = include_str!("schema.sql");

/// Dedicated key for command content and output, separate from execution-store keys.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct JobKey([u8; 32]);
impl JobKey {
    /// Takes custody of independently generated host key material.
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
    pub(crate) fn seal<T: Serialize>(&self, aad: &[u8], value: &T) -> Result<Vec<u8>> {
        let plaintext = Zeroizing::new(serde_json::to_vec(value)?);
        let mut nonce = [0; 24];
        getrandom::fill(&mut nonce).map_err(|_| Error::Randomness)?;
        let mut sealed = nonce.to_vec();
        sealed.extend(
            XChaCha20Poly1305::new((&self.0).into())
                .encrypt(
                    &XNonce::from(nonce),
                    Payload {
                        msg: &plaintext,
                        aad,
                    },
                )
                .map_err(|_| Error::Ciphertext)?,
        );
        Ok(sealed)
    }
    pub(crate) fn open<T: DeserializeOwned>(&self, aad: &[u8], sealed: &[u8]) -> Result<T> {
        let (nonce, ciphertext) = sealed.split_at_checked(24).ok_or(Error::Ciphertext)?;
        let nonce: [u8; 24] = nonce.try_into().map_err(|_| Error::Ciphertext)?;
        let plaintext = Zeroizing::new(
            XChaCha20Poly1305::new((&self.0).into())
                .decrypt(
                    &XNonce::from(nonce),
                    Payload {
                        msg: ciphertext,
                        aad,
                    },
                )
                .map_err(|_| Error::Ciphertext)?,
        );
        Ok(serde_json::from_slice(&plaintext)?)
    }
    #[cfg(all(feature = "worker", target_os = "linux"))]
    pub(crate) fn transfer(&self, target: &mut impl std::io::Write) -> Result<()> {
        target.write_all(&self.0)?;
        Ok(())
    }
}
impl std::fmt::Debug for JobKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JobKey([redacted])")
    }
}

/// Observed command lifecycle; primary exit is not descendant drain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Intent is stored without a worker reservation.
    Pending,
    /// A worker is reserved; its external start outcome may be unknown.
    Reserved,
    /// The original process is attached behind its release gate.
    Attached,
    /// Execution has been authorized or observed as started.
    Running,
    /// The primary process exited; descendants or output may remain.
    Exited,
    /// No execution was admitted, or the original process domain and output are drained.
    Drained,
}

/// Durable coordination facts for one original command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    /// Monotonic ledger revision, independent of output sequence.
    pub version: u64,
    /// Phase derived from the recorded facts.
    pub phase: Phase,
    /// Stop intent, preserved even before submission.
    pub stop_requested: bool,
    /// Original worker reservation; never silently replaced.
    pub worker: Option<Uuid>,
    /// Original process identity observed before release.
    pub process: Option<ProcessIdentity>,
    /// The host authorized release at least once.
    pub released: bool,
    /// The worker observed the process pass its release gate.
    pub started: bool,
    /// Primary process exit observed independently of descendant drain.
    pub primary_exit: Option<ExitStatus>,
    /// The final output sequence is durably stored.
    pub output_complete: bool,
    /// Highest contiguous output frame committed so far.
    pub last_sequence: u64,
}

/// An operation's authoritative coordination snapshot, not an execution goal result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    /// Authorization scope containing the operation; identifiers may repeat in another scope.
    pub scope_id: Uuid,
    /// Original client operation identity.
    pub operation_id: Uuid,
    /// Durable command facts, observed after commit by the broker.
    pub state: State,
}

/// One output slice; the cursor remains useful when no new output is available.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputPage {
    /// Original channel, absent when there are no bytes at the cursor.
    pub stream: Option<Stream>,
    /// URL-safe unpadded base64, preserving arbitrary process bytes.
    pub data: String,
    /// Opaque cursor scoped to this exact operation.
    pub cursor: String,
    /// No bytes remain and the worker has durably closed its output.
    pub complete: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Content {
    caller: Caller,
    request: Request,
    settings: Settings,
}

/// One transaction-locked ledger record. Discard it after a failed transaction.
#[derive(Clone)]
pub struct Record {
    id: JobId,
    content: Content,
    state: State,
}
impl Record {
    /// Original command identity.
    pub fn id(&self) -> JobId {
        self.id
    }
    /// Original caller, used for exact worker callbacks rather than a replacement identity.
    pub fn caller(&self) -> &Caller {
        &self.content.caller
    }
    /// Immutable request for host authorization and original worker reconciliation.
    pub fn request(&self) -> &Request {
        &self.content.request
    }
    /// Original host policy; subsequent deployment changes apply only to new operations.
    pub fn settings(&self) -> &Settings {
        &self.content.settings
    }
    /// Borrow current transaction-local facts without cloning the snapshot.
    pub fn state(&self) -> &State {
        &self.state
    }
    /// Current facts; a mutation's snapshot is provisional until its transaction commits.
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            scope_id: self.id.scope,
            operation_id: self.id.operation,
            state: self.state.clone(),
        }
    }
}
impl std::fmt::Debug for Record {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Record")
            .field("id", &self.id)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

/// Encrypted command ledger. Callers join authorization and these writes in one transaction.
#[derive(Clone, Debug)]
pub struct Ledger {
    key: Arc<JobKey>,
}
impl Ledger {
    /// Binds all records and outputs to the host's dedicated command key.
    pub fn new(key: JobKey) -> Self {
        Self { key: Arc::new(key) }
    }

    /// Lock or create the immutable original intent. Authorization must succeed before commit.
    /// Returns whether this transaction inserted the record. Existing cancellation always wins.
    pub async fn record(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        caller: &Caller,
        operation: Uuid,
        request: &Request,
        admission: Admission<'_>,
    ) -> Result<(Record, bool)> {
        request.validate()?;
        let (settings, cancelled) = match admission {
            Admission::Execute(settings) => (settings, false),
            Admission::Cancel(settings) => (settings, true),
        };
        settings.validate()?;
        durable(tx).await?;
        if caller.scope.is_nil() || operation.is_nil() {
            return Err(Error::Invalid);
        }
        let id = JobId {
            scope: caller.scope,
            operation,
        };
        let content = Content {
            caller: caller.clone(),
            request: request.clone(),
            settings: settings.clone(),
        };
        let state = State {
            version: 1,
            phase: if cancelled {
                Phase::Drained
            } else {
                Phase::Pending
            },
            stop_requested: cancelled,
            worker: None,
            process: None,
            released: false,
            started: false,
            primary_exit: None,
            output_complete: cancelled,
            last_sequence: 0,
        };
        let inserted = sqlx::query("INSERT INTO chopin_jobs(scope,operation,content,state,revision,drained) VALUES($1,$2,$3,$4,1,$5) ON CONFLICT(scope,operation) DO NOTHING")
            .bind(id.scope).bind(id.operation).bind(self.key.seal(&aad(id,"content",0),&content)?).bind(self.key.seal(&aad(id,"state",1),&state)?).bind(cancelled).execute(&mut **tx).await?.rows_affected() == 1;
        let record = self.read(tx, id).await?.ok_or(Error::NotFound)?;
        if record.request() != request {
            return Err(Error::Conflict);
        }
        Ok((record, inserted))
    }

    /// Lock one original record; absence is distinct from an unavailable database.
    pub async fn read(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: JobId,
    ) -> Result<Option<Record>> {
        let row = sqlx::query("SELECT content,state,revision FROM chopin_jobs WHERE scope=$1 AND operation=$2 FOR UPDATE")
            .bind(id.scope).bind(id.operation).fetch_optional(&mut **tx).await?;
        row.map(|row| {
            let version =
                u64::try_from(row.try_get::<i64, _>("revision")?).map_err(|_| Error::Ciphertext)?;
            let content = self
                .key
                .open(&aad(id, "content", 0), row.try_get::<&[u8], _>("content")?)?;
            let state: State = self.key.open(
                &aad(id, "state", version),
                row.try_get::<&[u8], _>("state")?,
            )?;
            if state.version != version {
                return Err(Error::Ciphertext);
            }
            Ok(Record { id, content, state })
        })
        .transpose()
    }

    /// Persist the exact worker before issuing a start request. No replacement is inferred from time.
    pub async fn reserve(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        record: &mut Record,
        worker: Uuid,
    ) -> Result<()> {
        if worker.is_nil() {
            return Err(Error::Invalid);
        }
        if let Some(previous) = record.state.worker {
            return if previous == worker {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }
        if record.state.phase != Phase::Pending || record.state.stop_requested {
            return Err(Error::Conflict);
        }
        let mut state = record.state.clone();
        state.worker = Some(worker);
        state.phase = Phase::Reserved;
        self.save(tx, record, state).await
    }

    /// Persist stop intent without claiming that an external process has already stopped.
    pub async fn stop(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        record: &mut Record,
    ) -> Result<()> {
        if record.state.stop_requested {
            return Ok(());
        }
        let mut state = record.state.clone();
        state.stop_requested = true;
        if state.worker.is_none() {
            state.phase = Phase::Drained;
            state.output_complete = true;
        }
        self.save(tx, record, state).await
    }

    /// Apply one callback after host authorization. Duplicate events must agree byte for byte.
    pub async fn event(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        record: &mut Record,
        worker: Uuid,
        event: &WorkerEvent,
    ) -> Result<()> {
        if record.state.worker != Some(worker) {
            return Err(Error::Forbidden);
        }
        let mut state = record.state.clone();
        match event {
            WorkerEvent::Read => return Ok(()),
            WorkerEvent::Attached { process } => {
                if process.domain != record.request().domain
                    || process.boot.is_nil()
                    || process.init_pid == 0
                    || process.start_ticks == 0
                    || process.namespace_inode == 0
                {
                    return Err(Error::Invalid);
                }
                if let Some(original) = &state.process {
                    if original != process {
                        return Err(Error::Conflict);
                    }
                    return Ok(());
                }
                if state.phase != Phase::Reserved {
                    return Err(Error::Conflict);
                }
                state.process = Some(process.clone());
                state.phase = Phase::Attached;
            }
            WorkerEvent::Release => {
                if state.stop_requested
                    || state.process.is_none()
                    || matches!(state.phase, Phase::Exited | Phase::Drained)
                {
                    return Err(Error::Conflict);
                }
                state.released = true;
                state.phase = Phase::Running;
            }
            WorkerEvent::Started => {
                if !state.released {
                    return Err(Error::Conflict);
                }
                state.started = true;
            }
            WorkerEvent::NotStarted => {
                if state.process.is_some() || state.released || state.last_sequence != 0 {
                    return Err(Error::Conflict);
                }
                state.stop_requested = true;
                state.output_complete = true;
                state.phase = Phase::Drained;
            }
            WorkerEvent::Output {
                sequence,
                stream,
                data,
            } => {
                let bytes = BASE64_URL_SAFE_NO_PAD
                    .decode(data)
                    .map_err(|_| Error::Invalid)?;
                if *sequence == 0 || bytes.is_empty() || bytes.len() > record.settings().frame_bytes
                {
                    return Err(Error::Invalid);
                }
                let incoming = Output {
                    stream: *stream,
                    bytes,
                };
                if *sequence <= state.last_sequence {
                    let stored = self
                        .frame(tx, record.id, *sequence)
                        .await?
                        .ok_or(Error::Conflict)?;
                    return if incoming == stored {
                        Ok(())
                    } else {
                        Err(Error::Conflict)
                    };
                }
                if state.process.is_none()
                    || state.output_complete
                    || state.last_sequence.checked_add(1) != Some(*sequence)
                {
                    return Err(Error::Conflict);
                }
                durable(tx).await?;
                sqlx::query("INSERT INTO chopin_job_output(scope,operation,sequence,sealed) VALUES($1,$2,$3,$4)")
                    .bind(record.id.scope).bind(record.id.operation).bind(integer(*sequence)?).bind(self.key.seal(&aad(record.id,"output",*sequence),&incoming)?).execute(&mut **tx).await?;
                state.last_sequence = *sequence;
            }
            WorkerEvent::Exited { exit } => {
                if state.process.is_none() {
                    return Err(Error::Conflict);
                }
                if let Some(previous) = &state.primary_exit {
                    return if previous == exit {
                        Ok(())
                    } else {
                        Err(Error::Conflict)
                    };
                }
                state.primary_exit = Some(exit.clone());
                state.phase = Phase::Exited;
            }
            WorkerEvent::OutputComplete { sequence } => {
                if state.process.is_none() || *sequence != state.last_sequence {
                    return Err(Error::Conflict);
                }
                state.output_complete = true;
            }
            WorkerEvent::Drained { process, sequence } => {
                if state.process.as_ref() != Some(process)
                    || state.primary_exit.is_none()
                    || !state.output_complete
                    || *sequence != state.last_sequence
                {
                    return Err(Error::Conflict);
                }
                state.phase = Phase::Drained;
            }
        }
        if state != record.state {
            self.save(tx, record, state).await?;
        }
        Ok(())
    }

    /// Read one channel-preserving output slice from an operation-bound cursor.
    pub async fn output(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        record: &Record,
        cursor: Option<&str>,
        bytes: NonZeroUsize,
    ) -> Result<OutputPage> {
        let mut cursor = match cursor {
            None => Cursor {
                id: record.id,
                sequence: 1,
                offset: 0,
            },
            Some(encoded) => serde_json::from_slice::<Cursor>(
                &BASE64_URL_SAFE_NO_PAD
                    .decode(encoded)
                    .map_err(|_| Error::Invalid)?,
            )
            .map_err(|_| Error::Invalid)?,
        };
        if cursor.id != record.id
            || cursor.sequence == 0
            || cursor.sequence > record.state.last_sequence.saturating_add(1)
        {
            return Err(Error::Invalid);
        }
        let (stream, data) = match self.frame(tx, record.id, cursor.sequence).await? {
            None if cursor.sequence == record.state.last_sequence + 1 && cursor.offset == 0 => {
                (None, String::new())
            }
            None => return Err(Error::Conflict),
            Some(output) => {
                if cursor.offset >= output.bytes.len() {
                    return Err(Error::Invalid);
                }
                let end = cursor
                    .offset
                    .saturating_add(bytes.get().min(record.settings().output_page_bytes))
                    .min(output.bytes.len());
                let data = BASE64_URL_SAFE_NO_PAD.encode(&output.bytes[cursor.offset..end]);
                cursor.offset = end;
                if end == output.bytes.len() {
                    cursor.sequence = cursor.sequence.checked_add(1).ok_or(Error::Invalid)?;
                    cursor.offset = 0;
                }
                (Some(output.stream), data)
            }
        };
        let complete = record.state.output_complete && cursor.sequence > record.state.last_sequence;
        Ok(OutputPage {
            stream,
            data,
            cursor: BASE64_URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor)?),
            complete,
        })
    }

    async fn frame(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: JobId,
        sequence: u64,
    ) -> Result<Option<Output>> {
        let bytes = sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT sealed FROM chopin_job_output WHERE scope=$1 AND operation=$2 AND sequence=$3",
        )
        .bind(id.scope)
        .bind(id.operation)
        .bind(integer(sequence)?)
        .fetch_optional(&mut **tx)
        .await?;
        bytes
            .map(|bytes| self.key.open(&aad(id, "output", sequence), &bytes))
            .transpose()
    }

    async fn save(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        record: &mut Record,
        mut state: State,
    ) -> Result<()> {
        durable(tx).await?;
        state.version = state.version.checked_add(1).ok_or(Error::Invalid)?;
        let changed = sqlx::query("UPDATE chopin_jobs SET state=$3,revision=$4,drained=$5 WHERE scope=$1 AND operation=$2 AND revision=$6")
            .bind(record.id.scope).bind(record.id.operation).bind(self.key.seal(&aad(record.id,"state",state.version),&state)?)
            .bind(integer(state.version)?).bind(state.phase == Phase::Drained).bind(integer(record.state.version)?).execute(&mut **tx).await?.rows_affected();
        if changed != 1 {
            return Err(Error::Conflict);
        }
        record.state = state;
        Ok(())
    }
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct Output {
    stream: Stream,
    bytes: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    id: JobId,
    sequence: u64,
    offset: usize,
}
fn aad(id: JobId, purpose: &str, sequence: u64) -> Vec<u8> {
    format!(
        "chopin:command:v1:{purpose}:{}:{}:{sequence}",
        id.scope, id.operation
    )
    .into_bytes()
}
fn integer(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::Invalid)
}

async fn durable(tx: &mut Transaction<'_, Postgres>) -> Result<()> {
    let (fsync, commit): (String, String) =
        sqlx::query_as("SELECT current_setting('fsync'),current_setting('synchronous_commit')")
            .fetch_one(&mut **tx)
            .await?;
    if fsync != "on" || !matches!(commit.as_str(), "on" | "remote_apply") {
        return Err(Error::Durability);
    }
    Ok(())
}

/// One source page of operations still requiring a running worker or reconciliation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingPage {
    /// Original identities in stable source order; completed operations may disappear between pages.
    pub operations: Vec<Uuid>,
    /// Scope-bound cursor; each recovery pass starts at the beginning to find newly admitted work.
    pub cursor: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingCursor {
    scope: Uuid,
    after: Uuid,
}
impl Ledger {
    /// Observe whether this ledger retains work. A failed query is never reported as idle.
    pub async fn has_pending(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        scope: Uuid,
    ) -> Result<bool> {
        Ok(sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM chopin_jobs WHERE scope=$1 AND NOT drained)",
        )
        .bind(scope)
        .fetch_one(&mut **tx)
        .await?)
    }
    /// Read exactly one source page. The host authenticates the scope in this transaction.
    pub async fn pending(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        scope: Uuid,
        limit: NonZeroUsize,
        cursor: Option<&str>,
    ) -> Result<PendingPage> {
        let after = match cursor {
            None => None,
            Some(encoded) => {
                let decoded: PendingCursor = serde_json::from_slice(
                    &BASE64_URL_SAFE_NO_PAD
                        .decode(encoded)
                        .map_err(|_| Error::Invalid)?,
                )
                .map_err(|_| Error::Invalid)?;
                if decoded.scope != scope {
                    return Err(Error::Invalid);
                }
                Some(decoded.after)
            }
        };
        let count = i64::try_from(limit.get())
            .ok()
            .and_then(|limit| limit.checked_add(1))
            .ok_or(Error::Invalid)?;
        let mut operations:Vec<Uuid>=sqlx::query_scalar("SELECT operation FROM chopin_jobs WHERE scope=$1 AND NOT drained AND ($2::uuid IS NULL OR operation>$2) ORDER BY operation LIMIT $3")
            .bind(scope).bind(after).bind(count).fetch_all(&mut **tx).await?;
        let more = operations.len() > limit.get();
        if more {
            operations.pop();
        }
        let cursor = if more {
            let after = operations.last().copied().ok_or(Error::Invalid)?;
            Some(
                BASE64_URL_SAFE_NO_PAD.encode(serde_json::to_vec(&PendingCursor { scope, after })?),
            )
        } else {
            None
        };
        Ok(PendingPage { operations, cursor })
    }
}
