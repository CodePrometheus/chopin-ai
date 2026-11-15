use std::{
    fs::{self, File, OpenOptions, TryLockError},
    num::NonZeroUsize,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use sqlx::{
    Connection, Row, Sqlite, SqliteConnection, Transaction,
    sqlite::{
        SqliteConnectOptions, SqliteJournalMode, SqliteLockingMode, SqliteRow, SqliteSynchronous,
    },
};
use tokio::sync::Mutex;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{GateCommand, HostIdentity, NamespaceConfig};
use crate::{Error, JobId, JobKey, ProcessIdentity, Result, WorkerStart, WorkerState};

/// Durable controller intent, not evidence that the requested external action occurred.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchStage {
    /// The immutable command is stored, with no launch attempt reserved.
    Accepted,
    /// The original controller reserved its only namespace launch attempt.
    Spawn,
    /// The original controller reserved its only gate release attempt.
    Release,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    start: WorkerStart,
    namespace: NamespaceConfig,
    stage: LaunchStage,
    released_at: Option<u64>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Content {
    plan: Option<Plan>,
    stopped: bool,
    terminal: Option<WorkerState>,
    process: Option<ProcessIdentity>,
    fenced: bool,
}

/// One original worker admission or cancellation tombstone, returned only after its transaction commits.
#[derive(Clone)]
pub struct WorkerRecord {
    id: JobId,
    revision: u64,
    content: Content,
}
impl std::fmt::Debug for WorkerRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerRecord")
            .field("id", &self.id)
            .field("revision", &self.revision)
            .field("stage", &self.stage())
            .field("stopped", &self.content.stopped)
            .finish_non_exhaustive()
    }
}
impl WorkerRecord {
    /// Original command identity.
    pub fn id(&self) -> JobId {
        self.id
    }
    /// Monotonic local record revision; it is not an execution-store generation.
    pub fn revision(&self) -> u64 {
        self.revision
    }
    /// Immutable admission, absent when cancellation arrived before submission.
    pub fn start(&self) -> Option<&WorkerStart> {
        self.content.plan.as_ref().map(|plan| &plan.start)
    }
    /// Original trusted mount and executable profile, unaffected by later host configuration changes.
    pub fn namespace(&self) -> Option<&NamespaceConfig> {
        self.content.plan.as_ref().map(|plan| &plan.namespace)
    }
    /// Last reserved external attempt. Reopening never grants a second attempt.
    pub fn stage(&self) -> Option<LaunchStage> {
        self.content.plan.as_ref().map(|plan| plan.stage)
    }
    /// Durable stop intent, independent of physical termination.
    pub fn stopped(&self) -> bool {
        self.content.stopped
    }
    /// Original terminal evidence recorded by the controller after physical reconciliation and delivery.
    pub fn terminal(&self) -> Option<&WorkerState> {
        self.content.terminal.as_ref()
    }
    /// Original namespace identity retained before any release authorization is requested.
    pub fn process(&self) -> Option<&ProcessIdentity> {
        self.content.process.as_ref()
    }
    /// Whether independent termination evidence was durably recorded for that original namespace.
    pub fn fenced(&self) -> bool {
        self.content.fenced
    }
    /// Original resolved command. Inheritance uses the encrypted admission profile, never ambient variables.
    pub fn command(&self) -> Option<GateCommand> {
        let plan = self.content.plan.as_ref()?;
        let request = &plan.start.request;
        let mut env = if request.inherit_env {
            plan.namespace.environment.clone()
        } else {
            Default::default()
        };
        env.extend(request.env.clone());
        Some(GateCommand {
            version: 1,
            argv: request.argv.clone(),
            cwd: request.cwd.clone(),
            env,
        })
    }
    /// Whether the original release budget expired on this kernel boot, including suspended time.
    pub fn expired(&self) -> Result<bool> {
        Ok(self
            .remaining()?
            .is_some_and(|remaining| remaining.is_zero()))
    }
    /// Remaining time from the first durable release reservation, without extending it on recovery.
    pub fn remaining(&self) -> Result<Option<Duration>> {
        let Some(plan) = self.content.plan.as_ref() else {
            return Ok(None);
        };
        let (Some(released), Some(timeout)) = (plan.released_at, plan.start.request.timeout_ms)
        else {
            return Ok(None);
        };
        let deadline = released
            .checked_add(timeout.checked_mul(1_000_000).ok_or(Error::Invalid)?)
            .ok_or(Error::Invalid)?;
        Ok(Some(Duration::from_nanos(
            deadline.saturating_sub(boottime()?),
        )))
    }
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    version: u32,
    worker: Uuid,
    host: HostIdentity,
    root: FileIdentity,
    database: FileIdentity,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

/// Exclusive local worker journal. Hosts must supply durable, fresh local storage and retain its key.
/// This journal never interprets controller ownership as proof that a command namespace has drained.
pub struct WorkerJournal {
    connection: Mutex<Option<SqliteConnection>>,
    directory: PathBuf,
    root: File,
    lock: File,
    identity: Identity,
    key: Arc<JobKey>,
}
impl std::fmt::Debug for WorkerJournal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerJournal")
            .field("worker", &self.identity.worker)
            .field("host", &self.identity.host)
            .finish_non_exhaustive()
    }
}
impl WorkerJournal {
    /// Initialize new private storage without replacing any existing journal or lock.
    /// A failed initialization preserves its files and cannot be retried as an empty database.
    pub async fn create(
        directory: &Path,
        worker: Uuid,
        host: HostIdentity,
        key: Arc<JobKey>,
    ) -> Result<Self> {
        Self::connect(directory, worker, host, key, true).await
    }
    /// Reopen the original journal. Missing files, changed identity and active controllers are errors.
    pub async fn open(
        directory: &Path,
        worker: Uuid,
        host: HostIdentity,
        key: Arc<JobKey>,
    ) -> Result<Self> {
        Self::connect(directory, worker, host, key, false).await
    }
    async fn connect(
        directory: &Path,
        worker: Uuid,
        host: HostIdentity,
        key: Arc<JobKey>,
        create: bool,
    ) -> Result<Self> {
        if worker.is_nil() {
            return Err(Error::Invalid);
        }
        host.verify()?;
        let directory = fs::canonicalize(directory)?;
        let root = File::open(&directory)?;
        if !root.metadata()?.is_dir() {
            return Err(Error::Invalid);
        }
        if create {
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
        let lock = OpenOptions::new()
            .create_new(create)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(directory.join("controller.lock"))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(Error::Conflict),
            Err(TryLockError::Error(error)) => return Err(error.into()),
        }
        let path = directory.join("worker.db");
        if create {
            lock.sync_all()?;
            File::options()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)?
                .sync_all()?;
            root.sync_all()?;
        }
        let database = object(&fs::metadata(&path)?);
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(false)
            .locking_mode(SqliteLockingMode::Exclusive)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::ZERO)
            .pragma("trusted_schema", "OFF");
        let mut connection = SqliteConnection::connect_with(&options).await?;
        let identity = Identity {
            version: 1,
            worker,
            host,
            root: object(&root.metadata()?),
            database,
        };
        let initialization = async {
            durable(&mut connection).await?;
            if create {
                let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                sqlx::raw_sql(include_str!("journal.sql"))
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("INSERT INTO worker_identity(singleton,sealed) VALUES(1,?)")
                    .bind(key.seal(&identity_aad(worker), &identity)?)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                root.sync_all()?;
            }
            let row = sqlx::query("SELECT sealed FROM worker_identity WHERE singleton=1")
                .fetch_one(&mut connection)
                .await?;
            let stored: Identity = key.open(&identity_aad(worker), row.try_get("sealed")?)?;
            if stored != identity {
                return Err(Error::Conflict);
            }
            Ok(())
        }
        .await;
        if let Err(error) = initialization {
            connection.close().await?;
            return Err(error);
        }
        let journal = Self {
            connection: Mutex::new(Some(connection)),
            directory,
            root,
            lock,
            identity,
            key,
        };
        journal.verify()?;
        Ok(journal)
    }
    /// The physical context retained by the original worker registration.
    pub fn host(&self) -> &HostIdentity {
        &self.identity.host
    }
    /// Immutable worker registration identity.
    pub fn worker(&self) -> Uuid {
        self.identity.worker
    }
    /// Private storage root, also containing the operation's gate and capture records.
    pub fn directory(&self) -> &Path {
        &self.directory
    }
    /// Read an original operation. `None` is returned only after a successful observation of this journal.
    pub async fn get(&self, id: JobId) -> Result<Option<WorkerRecord>> {
        valid_id(id)?;
        self.verify()?;
        let mut held = self.connection.lock().await;
        let connection = held.as_mut().ok_or(Error::Conflict)?;
        let row = sqlx::query("SELECT scope,operation,revision,settled,sealed FROM worker_jobs WHERE scope=? AND operation=?")
            .bind(id.scope).bind(id.operation).fetch_optional(connection).await?;
        let result = row.map(|row| self.decode(&row)).transpose()?;
        self.verify()?;
        Ok(result)
    }
    /// Atomically admit the immutable request. A preexisting cancellation remains a tombstone.
    /// An identical admission retains its original profile even if the host's current profile changed.
    pub async fn admit(
        &self,
        start: &WorkerStart,
        namespace: &NamespaceConfig,
    ) -> Result<WorkerRecord> {
        start.validate()?;
        if start.request.domain != self.identity.host.domain {
            return Err(Error::Forbidden);
        }
        self.verify()?;
        let mut held = self.connection.lock().await;
        let connection = held.as_mut().ok_or(Error::Conflict)?;
        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
        let record = if let Some(record) = self.read(&mut tx, start.id).await? {
            if record.start().is_some_and(|original| original != start) {
                return Err(Error::Conflict);
            }
            record
        } else {
            namespace.validate()?;
            if fs::canonicalize(&namespace.private_root)? != self.directory {
                return Err(Error::Forbidden);
            }
            let record = WorkerRecord {
                id: start.id,
                revision: 1,
                content: Content {
                    plan: Some(Plan {
                        start: start.clone(),
                        namespace: namespace.clone(),
                        stage: LaunchStage::Accepted,
                        released_at: None,
                    }),
                    stopped: false,
                    terminal: None,
                    process: None,
                    fenced: false,
                },
            };
            let command = Zeroizing::new(serde_json::to_vec(
                &record.command().ok_or(Error::Invalid)?,
            )?);
            if command.len() > start.settings.max_body_bytes {
                return Err(Error::Invalid);
            }
            self.insert(&mut tx, &record).await?;
            record
        };
        tx.commit().await?;
        self.root.sync_all()?;
        self.verify()?;
        Ok(record)
    }
    /// Persist cancellation before acting on a process, including when no admission exists yet.
    pub async fn stop(&self, id: JobId) -> Result<WorkerRecord> {
        valid_id(id)?;
        self.verify()?;
        let mut held = self.connection.lock().await;
        let connection = held.as_mut().ok_or(Error::Conflict)?;
        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
        let record = if let Some(mut record) = self.read(&mut tx, id).await? {
            if !record.stopped() && record.terminal().is_none() {
                record.content.stopped = true;
                if record.stage() == Some(LaunchStage::Accepted) {
                    record.content.terminal = Some(WorkerState::Cancelled);
                }
                self.save(&mut tx, &mut record).await?;
            }
            record
        } else {
            let record = WorkerRecord {
                id,
                revision: 1,
                content: Content {
                    plan: None,
                    stopped: true,
                    terminal: Some(WorkerState::Cancelled),
                    process: None,
                    fenced: false,
                },
            };
            self.insert(&mut tx, &record).await?;
            record
        };
        tx.commit().await?;
        self.root.sync_all()?;
        self.verify()?;
        Ok(record)
    }
    /// Reserve the only namespace launch. `false` requires reconciliation, never another spawn.
    pub async fn spawn(&self, id: JobId) -> Result<bool> {
        self.advance(id, LaunchStage::Accepted, LaunchStage::Spawn)
            .await
    }
    /// Reserve the only gate send after current broker authorization. `false` never grants replay.
    pub async fn release(&self, id: JobId) -> Result<bool> {
        self.advance(id, LaunchStage::Spawn, LaunchStage::Release)
            .await
    }
    /// Retain the independently observed original gate identity. The binding is immutable.
    pub async fn bind(&self, id: JobId, process: ProcessIdentity) -> Result<WorkerRecord> {
        if process.domain != self.identity.host.domain
            || process.boot != self.identity.host.boot
            || process.init_pid == 0
            || process.start_ticks == 0
            || process.namespace_inode == 0
            || process.namespace_inode == self.identity.host.pid_namespace_inode
        {
            return Err(Error::Conflict);
        }
        self.update(id, |record| {
            if let Some(original) = record.process() {
                return if original == &process {
                    Ok(false)
                } else {
                    Err(Error::Conflict)
                };
            }
            if !matches!(
                record.stage(),
                Some(LaunchStage::Spawn | LaunchStage::Release)
            ) || record.terminal().is_some()
            {
                return Err(Error::Conflict);
            }
            record.content.process = Some(process);
            Ok(true)
        })
        .await
    }
    /// Persist positive kernel termination evidence for the exact recorded namespace.
    /// The controller must observe the original process handle; leases and missing status are insufficient.
    pub async fn fence(&self, id: JobId, process: &ProcessIdentity) -> Result<WorkerRecord> {
        self.update(id, |record| {
            if record.process() != Some(process) {
                return Err(Error::Conflict);
            }
            let changed = !record.content.fenced;
            record.content.fenced = true;
            Ok(changed)
        })
        .await
    }
    async fn update(
        &self,
        id: JobId,
        change: impl FnOnce(&mut WorkerRecord) -> Result<bool>,
    ) -> Result<WorkerRecord> {
        valid_id(id)?;
        self.verify()?;
        let mut held = self.connection.lock().await;
        let mut tx = held
            .as_mut()
            .ok_or(Error::Conflict)?
            .begin_with("BEGIN IMMEDIATE")
            .await?;
        let mut record = self.read(&mut tx, id).await?.ok_or(Error::NotFound)?;
        if change(&mut record)? {
            self.save(&mut tx, &mut record).await?;
        }
        tx.commit().await?;
        self.root.sync_all()?;
        self.verify()?;
        Ok(record)
    }
    async fn advance(&self, id: JobId, expected: LaunchStage, next: LaunchStage) -> Result<bool> {
        valid_id(id)?;
        self.verify()?;
        let mut held = self.connection.lock().await;
        let connection = held.as_mut().ok_or(Error::Conflict)?;
        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
        let mut record = self.read(&mut tx, id).await?.ok_or(Error::NotFound)?;
        if record.stopped() || record.terminal().is_some() {
            return Err(Error::Conflict);
        }
        let stage = record.stage().ok_or(Error::Conflict)?;
        if next == LaunchStage::Release && record.process().is_none() {
            return Err(Error::Conflict);
        }
        let changed =
            if stage == next || (next == LaunchStage::Spawn && stage == LaunchStage::Release) {
                false
            } else {
                if stage != expected {
                    return Err(Error::Conflict);
                }
                let plan = record.content.plan.as_mut().ok_or(Error::Conflict)?;
                plan.stage = next;
                if next == LaunchStage::Release {
                    let released = boottime()?;
                    if let Some(timeout) = plan.start.request.timeout_ms {
                        released
                            .checked_add(timeout.checked_mul(1_000_000).ok_or(Error::Invalid)?)
                            .ok_or(Error::Invalid)?;
                    }
                    plan.released_at = Some(released);
                }
                self.save(&mut tx, &mut record).await?;
                true
            };
        tx.commit().await?;
        self.root.sync_all()?;
        self.verify()?;
        Ok(changed)
    }
    /// Retain a verified final observation after the controller reconciles processes and delivers output.
    /// The caller supplies physical evidence; this write does not derive termination from a lease or intent.
    pub async fn finish(&self, id: JobId, terminal: WorkerState) -> Result<WorkerRecord> {
        valid_id(id)?;
        self.verify()?;
        let mut held = self.connection.lock().await;
        let connection = held.as_mut().ok_or(Error::Conflict)?;
        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
        let mut record = self.read(&mut tx, id).await?.ok_or(Error::NotFound)?;
        if let Some(original) = record.terminal() {
            if original != &terminal {
                return Err(Error::Conflict);
            }
        } else {
            match &terminal {
                WorkerState::Cancelled
                    if record.stage() != Some(LaunchStage::Release)
                        && record.process().is_none() =>
                {
                    record.content.stopped = true
                }
                WorkerState::Drained { process, .. }
                    if matches!(
                        record.stage(),
                        Some(LaunchStage::Spawn | LaunchStage::Release)
                    ) && process.domain == self.identity.host.domain
                        && record.process() == Some(process)
                        && record.fenced()
                        && process.boot == self.identity.host.boot
                        && process.init_pid > 0
                        && process.start_ticks > 0
                        && process.namespace_inode > 0
                        && process.namespace_inode != self.identity.host.pid_namespace_inode => {}
                _ => return Err(Error::Conflict),
            }
            record.content.terminal = Some(terminal);
            self.save(&mut tx, &mut record).await?;
        }
        tx.commit().await?;
        self.root.sync_all()?;
        self.verify()?;
        Ok(record)
    }
    /// Read an ordered recovery page. Continue after its last identity until a page is empty.
    /// Start each subsequent recovery pass from the beginning to discover newly admitted earlier identities.
    pub async fn pending(
        &self,
        after: Option<JobId>,
        limit: NonZeroUsize,
    ) -> Result<Vec<WorkerRecord>> {
        self.verify()?;
        let mut held = self.connection.lock().await;
        let connection = held.as_mut().ok_or(Error::Conflict)?;
        let limit = i64::try_from(limit.get()).map_err(|_| Error::Invalid)?;
        let rows = if let Some(after) = after {
            valid_id(after)?;
            sqlx::query("SELECT scope,operation,revision,settled,sealed FROM worker_jobs WHERE settled=0 AND (scope,operation)>(?,?) ORDER BY scope,operation LIMIT ?")
                .bind(after.scope).bind(after.operation).bind(limit).fetch_all(connection).await?
        } else {
            sqlx::query("SELECT scope,operation,revision,settled,sealed FROM worker_jobs WHERE settled=0 ORDER BY scope,operation LIMIT ?")
                .bind(limit).fetch_all(connection).await?
        };
        let result = rows
            .iter()
            .map(|row| self.decode(row))
            .collect::<Result<Vec<_>>>()?;
        self.verify()?;
        Ok(result)
    }
    /// Close the database while retaining controller ownership until this object is dropped.
    /// Closing storage does not terminate or fence a previously admitted command.
    pub async fn close(&self) -> Result<()> {
        if let Some(connection) = self.connection.lock().await.take() {
            connection.close().await?;
        }
        Ok(())
    }
    async fn read(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        id: JobId,
    ) -> Result<Option<WorkerRecord>> {
        let row = sqlx::query("SELECT scope,operation,revision,settled,sealed FROM worker_jobs WHERE scope=? AND operation=?")
            .bind(id.scope).bind(id.operation).fetch_optional(&mut **tx).await?;
        row.map(|row| self.decode(&row)).transpose()
    }
    fn decode(&self, row: &SqliteRow) -> Result<WorkerRecord> {
        let id = JobId {
            scope: row.try_get("scope")?,
            operation: row.try_get("operation")?,
        };
        valid_id(id)?;
        let revision =
            u64::try_from(row.try_get::<i64, _>("revision")?).map_err(|_| Error::Invalid)?;
        let content: Content = self.key.open(
            &aad(self.identity.worker, id, revision),
            row.try_get("sealed")?,
        )?;
        if revision == 0
            || content.terminal.is_some() != row.try_get::<bool, _>("settled")?
            || content.plan.as_ref().is_some_and(|plan| {
                plan.start.id != id
                    || plan.start.request.domain != self.identity.host.domain
                    || (plan.stage == LaunchStage::Release) != plan.released_at.is_some()
            })
            || content.plan.is_none()
                && (!content.stopped || content.terminal != Some(WorkerState::Cancelled))
            || content.fenced && content.process.is_none()
        {
            return Err(Error::Conflict);
        }
        Ok(WorkerRecord {
            id,
            revision,
            content,
        })
    }
    async fn insert(&self, tx: &mut Transaction<'_, Sqlite>, record: &WorkerRecord) -> Result<()> {
        sqlx::query(
            "INSERT INTO worker_jobs(scope,operation,revision,settled,sealed) VALUES(?,?,?,?,?)",
        )
        .bind(record.id.scope)
        .bind(record.id.operation)
        .bind(integer(record.revision)?)
        .bind(record.terminal().is_some())
        .bind(self.key.seal(
            &aad(self.identity.worker, record.id, record.revision),
            &record.content,
        )?)
        .execute(&mut **tx)
        .await?;
        Ok(())
    }
    async fn save(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        record: &mut WorkerRecord,
    ) -> Result<()> {
        record.revision = record.revision.checked_add(1).ok_or(Error::Invalid)?;
        if sqlx::query("UPDATE worker_jobs SET revision=?,settled=?,sealed=? WHERE scope=? AND operation=? AND revision=?")
            .bind(integer(record.revision)?).bind(record.terminal().is_some())
            .bind(self.key.seal(&aad(self.identity.worker, record.id, record.revision), &record.content)?)
            .bind(record.id.scope).bind(record.id.operation).bind(integer(record.revision - 1)?)
            .execute(&mut **tx).await?.rows_affected() != 1 { return Err(Error::Conflict); }
        Ok(())
    }
    fn verify(&self) -> Result<()> {
        self.identity.host.verify()?;
        if object(&fs::metadata(&self.directory)?) != object(&self.root.metadata()?)
            || object(&fs::metadata(self.directory.join("controller.lock"))?)
                != object(&self.lock.metadata()?)
            || object(&fs::metadata(self.directory.join("worker.db"))?) != self.identity.database
        {
            return Err(Error::Conflict);
        }
        Ok(())
    }
}
fn boottime() -> Result<u64> {
    let time = rustix::time::clock_gettime(rustix::time::ClockId::Boottime);
    u64::try_from(time.tv_sec)
        .ok()
        .and_then(|seconds| seconds.checked_mul(1_000_000_000))
        .and_then(|nanos| {
            u64::try_from(time.tv_nsec)
                .ok()
                .and_then(|part| nanos.checked_add(part))
        })
        .ok_or(Error::Invalid)
}
async fn durable(connection: &mut SqliteConnection) -> Result<()> {
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(&mut *connection)
        .await?;
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut *connection)
        .await?;
    let locking: String = sqlx::query_scalar("PRAGMA locking_mode")
        .fetch_one(&mut *connection)
        .await?;
    if synchronous != 2 || journal != "wal" || locking != "exclusive" {
        return Err(Error::Durability);
    }
    Ok(())
}
fn object(metadata: &fs::Metadata) -> FileIdentity {
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}
fn valid_id(id: JobId) -> Result<()> {
    if id.scope.is_nil() || id.operation.is_nil() {
        return Err(Error::Invalid);
    }
    Ok(())
}
fn integer(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::Invalid)
}
fn identity_aad(worker: Uuid) -> Vec<u8> {
    format!("worker-journal/1:{worker}:identity").into_bytes()
}
fn aad(worker: Uuid, id: JobId, revision: u64) -> Vec<u8> {
    format!(
        "worker-journal/1:{worker}:{}:{}:{revision}",
        id.scope, id.operation
    )
    .into_bytes()
}

#[cfg(test)]
#[path = "../../tests/journal/mod.rs"]
mod tests;
