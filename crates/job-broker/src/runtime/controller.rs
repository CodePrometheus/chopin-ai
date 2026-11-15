use std::{
    collections::HashMap,
    fs::{self, File},
    num::NonZeroUsize,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

use super::{
    CaptureOptions, GateRecord, LaunchStage, Namespace, NamespaceConfig, NamespaceProcess,
    OutputReader, ProcessObservation, WorkerJournal, WorkerRecord, read_exit, read_records,
};
use crate::{
    ControlClient, Error, JobId, JobKey, Result, Snapshot, WorkerEvent, WorkerObservation,
    WorkerStart, WorkerState,
};

/// Trusted admission policy for this concrete worker. Requests never choose their own mounts or ambient secrets.
#[async_trait::async_trait]
pub trait WorkerPolicy: Send + Sync {
    /// Resolve and authorize the immutable execution profile for a new admission.
    /// Existing operations keep their previously stored profile, including after this policy changes.
    async fn profile(&self, start: &WorkerStart) -> Result<NamespaceConfig>;
}

#[derive(Default)]
struct Session {
    namespace: Option<Namespace>,
    process: Option<NamespaceProcess>,
}

/// Original-operation controller over a durable journal, protected commands and authenticated callbacks.
/// The host owns its recovery loop and HTTP admission lifetime. Dropping it does not cancel released work.
pub struct LocalWorker {
    journal: WorkerJournal,
    policy: Arc<dyn WorkerPolicy>,
    control: ControlClient,
    output_key: Arc<JobKey>,
    sessions: Mutex<HashMap<JobId, Arc<Mutex<Session>>>>,
    changed: Notify,
}
impl std::fmt::Debug for LocalWorker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalWorker")
            .field("journal", &self.journal)
            .finish_non_exhaustive()
    }
}

/// One reconciliation result. A failed observation remains an error, never a successful idle result.
#[derive(Debug)]
pub struct WorkerRecovery {
    /// Original command identity.
    pub id: JobId,
    /// Actual result of reconciling this operation.
    pub result: Result<WorkerObservation>,
}
/// One page of original worker operations; unrelated failures do not prevent the remaining records from being tried.
#[derive(Debug)]
pub struct WorkerRecoveryPage {
    /// Per-operation results in source order.
    pub results: Vec<WorkerRecovery>,
    /// Continue after this source identity; an empty source page terminates the pass.
    pub next: Option<JobId>,
}

impl LocalWorker {
    /// Take exclusive custody of a verified journal and its original output key.
    pub fn new(
        journal: WorkerJournal,
        policy: Arc<dyn WorkerPolicy>,
        control: ControlClient,
        output_key: Arc<JobKey>,
    ) -> Self {
        Self {
            journal,
            policy,
            control,
            output_key,
            sessions: Mutex::new(HashMap::new()),
            changed: Notify::new(),
        }
    }
    /// Commit one original admission before a recovery loop can create its gated namespace.
    /// The returned receipt contains no claim that execution started or finished.
    pub async fn admit(&self, start: &WorkerStart) -> Result<WorkerObservation> {
        start.validate()?;
        if start.request.domain != self.journal.host().domain {
            return Err(Error::Forbidden);
        }
        let record = if let Some(record) = self.journal.get(start.id).await? {
            if record.start().is_some_and(|original| original != start) {
                return Err(Error::Conflict);
            }
            record
        } else {
            let profile = self.policy.profile(start).await?;
            self.journal.admit(start, &profile).await?
        };
        self.changed.notify_one();
        Ok(self.receipt(&record))
    }
    /// Observe one exact original admission. Missing or failed process and output observations are errors.
    /// `None` requires a successful query of the retained journal, never a missing file or process.
    pub async fn observe(&self, id: JobId) -> Result<Option<WorkerObservation>> {
        let Some(record) = self.journal.get(id).await? else {
            return Ok(None);
        };
        if record.terminal().is_some() || record.stage() == Some(LaunchStage::Accepted) {
            return Ok(Some(self.receipt(&record)));
        }
        let session = self.session(id).await;
        let mut session = session.lock().await;
        self.physical(&record, &mut session).await.map(Some)
    }
    /// Commit stop before signaling the exact original namespace. This acknowledgement alone is not termination.
    pub async fn stop(&self, id: JobId) -> Result<WorkerObservation> {
        let record = self.journal.stop(id).await?;
        self.changed.notify_one();
        if let Some(process) = record.process().filter(|_| !record.fenced()) {
            match NamespaceProcess::open(self.journal.host(), process)? {
                ProcessObservation::Alive(handle) => handle.terminate()?,
                ProcessObservation::Exited => {
                    self.journal.fence(id, process).await?;
                }
            }
        }
        Ok(self.receipt(&record))
    }
    /// Reconcile a single original operation. Reserved attempts are observed, never blindly repeated.
    pub async fn reconcile(&self, id: JobId) -> Result<WorkerObservation> {
        let session = self.session(id).await;
        let mut held = session.lock().await;
        let result = self.advance(id, &mut held).await;
        drop(held);
        if self
            .journal
            .get(id)
            .await?
            .is_some_and(|record| record.terminal().is_some())
        {
            self.sessions.lock().await.remove(&id);
        }
        result
    }
    /// Recover one source page; the host supplies cadence, cancellation and the observed task lifetime.
    pub async fn recover(
        &self,
        after: Option<JobId>,
        limit: NonZeroUsize,
    ) -> Result<WorkerRecoveryPage> {
        let page = self.journal.pending(after, limit).await?;
        let next = page.last().map(WorkerRecord::id);
        let mut results = Vec::with_capacity(page.len());
        for record in page {
            let id = record.id();
            results.push(WorkerRecovery {
                id,
                result: self.reconcile(id).await,
            });
        }
        Ok(WorkerRecoveryPage { results, next })
    }
    /// Close controller inputs and the journal after the host has joined all callers and recovery tasks.
    /// Released commands and their independent output capture continue; reopening reconciles them.
    pub async fn close(self) -> Result<()> {
        drop(self.sessions.into_inner());
        self.journal.close().await
    }
    /// Immutable registration expected in every worker response.
    pub fn worker(&self) -> Uuid {
        self.journal.worker()
    }
    /// Wake the host's recovery loop after a committed admission or stop request.
    /// This notification is only a hint; the journal remains the source of recovery work.
    pub async fn changed(&self) {
        self.changed.notified().await;
    }
    async fn session(&self, id: JobId) -> Arc<Mutex<Session>> {
        self.sessions.lock().await.entry(id).or_default().clone()
    }
    async fn advance(&self, id: JobId, session: &mut Session) -> Result<WorkerObservation> {
        let mut record = self.journal.get(id).await?.ok_or(Error::NotFound)?;
        if record.terminal().is_some() {
            return Ok(self.receipt(&record));
        }
        let start = record.start().ok_or(Error::Conflict)?.clone();
        if record.stage() == Some(LaunchStage::Accepted) {
            if !self.journal.spawn(id).await? {
                return Err(Error::Conflict);
            }
            let directory = self.reserve(id)?;
            session.namespace = Some(Namespace::spawn(
                record.namespace().ok_or(Error::Conflict)?,
                &directory,
                self.journal.host(),
                NonZeroUsize::new(start.settings.max_body_bytes).ok_or(Error::Invalid)?,
                &self.output(&record)?,
            )?);
            record = self.journal.get(id).await?.ok_or(Error::NotFound)?;
        }
        let directory = self.directory(id);
        let facts = match read_records(&directory) {
            Ok(facts) => facts,
            Err(Error::Io(error))
                if error.kind() == std::io::ErrorKind::NotFound
                    && record.stage() == Some(LaunchStage::Spawn)
                    && record.process().is_none()
                    && session.namespace.is_none() =>
            {
                Vec::new()
            }
            Err(error) => return Err(error),
        };
        let Some(GateRecord::Ready { process }) = facts.first() else {
            if let Some(namespace) = &mut session.namespace {
                if record.stopped() {
                    namespace.refuse();
                }
                if namespace.try_wait()?.is_none() {
                    return Ok(self.receipt(&record));
                }
                namespace.refuse();
            }
            return self.abandon(&record).await;
        };
        record = self.journal.bind(id, process.clone()).await?;
        if record.expired()?
            || session.namespace.is_none() && record.stage() != Some(LaunchStage::Release)
        {
            record = self.journal.stop(id).await?;
        }
        if !record.fenced() {
            if session.process.is_none() {
                match NamespaceProcess::open(self.journal.host(), process)? {
                    ProcessObservation::Alive(handle) => session.process = Some(handle),
                    ProcessObservation::Exited => {
                        record = self.journal.fence(id, process).await?;
                    }
                }
            }
            if let Some(handle) = &session.process {
                if record.stopped() {
                    handle.terminate()?;
                }
                if handle.has_exited()? {
                    record = self.journal.fence(id, process).await?;
                }
            }
        }
        if (record.stopped() || record.fenced())
            && let Some(namespace) = &mut session.namespace
        {
            namespace.refuse();
        }
        let snapshot = self
            .event(
                &start,
                &WorkerEvent::Attached {
                    process: process.clone(),
                },
            )
            .await?;
        if snapshot.state.stop_requested && !record.stopped() {
            record = self.journal.stop(id).await?;
            if let Some(handle) = &session.process {
                handle.terminate()?;
            }
            if let Some(namespace) = &mut session.namespace {
                namespace.refuse();
            }
        }
        if !record.stopped()
            && !record.fenced()
            && matches!(facts.as_slice(), [GateRecord::Ready { .. }])
            && let Some(namespace) = &mut session.namespace
            && record.stage() == Some(LaunchStage::Spawn)
            && namespace.output_ready()?
        {
            match self.event(&start, &WorkerEvent::Release).await {
                Ok(snapshot) if !snapshot.state.stop_requested => {
                    if self.journal.release(id).await? {
                        let latest = self.journal.get(id).await?.ok_or(Error::NotFound)?;
                        if latest.stopped() || latest.expired()? {
                            self.journal.stop(id).await?;
                            namespace.refuse();
                        } else {
                            let command = latest.command().ok_or(Error::Conflict)?;
                            let result = if let Some(remaining) = latest.remaining()? {
                                tokio::time::timeout(remaining, namespace.release(&command))
                                    .await
                                    .unwrap_or(Err(Error::Unavailable {
                                        retry_after_ms: start.settings.poll_after_ms,
                                    }))
                            } else {
                                namespace.release(&command).await
                            };
                            if let Err(error) = result {
                                namespace.refuse();
                                self.journal.stop(id).await?;
                                if let Some(handle) = &session.process {
                                    handle.terminate()?;
                                }
                                return Err(error);
                            }
                        }
                    }
                }
                Ok(_) | Err(Error::Forbidden | Error::Unauthorized | Error::Conflict) => {
                    self.journal.stop(id).await?;
                    namespace.refuse();
                }
                Err(error) => return Err(error),
            }
        }
        record = self.journal.get(id).await?.ok_or(Error::NotFound)?;
        let facts = read_records(&directory)?;
        if let [GateRecord::Ready { .. }, GateRecord::Released { digest }] = facts.as_slice() {
            if record.stage() != Some(LaunchStage::Release)
                || digest != &record.command().ok_or(Error::Conflict)?.digest()?
            {
                return Err(Error::Conflict);
            }
            self.event(&start, &WorkerEvent::Started).await?;
        }
        if let Some(exit) = read_exit(&directory, process)? {
            self.event(&start, &WorkerEvent::Exited { exit }).await?;
        }
        let reader = OutputReader::open(&directory, &self.output(&record)?)?;
        let delivered = if reader.ready()? {
            Some(
                self.external(&start, reader.deliver(&self.control, &start.callback))
                    .await?,
            )
        } else {
            None
        };
        let observation = self.physical(&record, session).await?;
        if let WorkerState::Drained {
            process,
            exit,
            sequence,
        } = &observation.state
            && delivered.as_ref().is_some_and(|snapshot| {
                snapshot.state.output_complete
                    && snapshot.state.last_sequence == *sequence
                    && snapshot.state.primary_exit.as_ref() == Some(exit)
            })
        {
            if let Some(namespace) = &mut session.namespace {
                if namespace.try_wait()?.is_none() {
                    return Ok(observation);
                }
                namespace.wait_output().await?;
            }
            self.event(
                &start,
                &WorkerEvent::Drained {
                    process: process.clone(),
                    sequence: *sequence,
                },
            )
            .await?;
            self.journal.finish(id, observation.state.clone()).await?;
        }
        Ok(observation)
    }
    async fn abandon(&self, record: &WorkerRecord) -> Result<WorkerObservation> {
        if record.stage() != Some(LaunchStage::Spawn) || record.process().is_some() {
            return Err(Error::Conflict);
        }
        let start = record.start().ok_or(Error::Conflict)?;
        let snapshot = self.event(start, &WorkerEvent::Read).await?;
        if snapshot.state.process.is_some() || snapshot.state.released {
            return Err(Error::Conflict);
        }
        self.journal.stop(record.id()).await?;
        self.event(start, &WorkerEvent::NotStarted).await?;
        let record = self
            .journal
            .finish(record.id(), WorkerState::Cancelled)
            .await?;
        Ok(self.receipt(&record))
    }
    async fn physical(
        &self,
        record: &WorkerRecord,
        session: &mut Session,
    ) -> Result<WorkerObservation> {
        let directory = self.directory(record.id());
        let facts = read_records(&directory)?;
        let Some(GateRecord::Ready { process }) = facts.first() else {
            return Ok(self.receipt(record));
        };
        let mut record = self.journal.bind(record.id(), process.clone()).await?;
        if !record.fenced() {
            if let Some(handle) = &session.process {
                if handle.identity() != process {
                    return Err(Error::Conflict);
                }
                if handle.has_exited()? {
                    record = self.journal.fence(record.id(), process).await?;
                }
            } else {
                match NamespaceProcess::open(self.journal.host(), process)? {
                    ProcessObservation::Alive(handle) => session.process = Some(handle),
                    ProcessObservation::Exited => {
                        record = self.journal.fence(record.id(), process).await?;
                    }
                }
            }
        }
        let reader = OutputReader::open(&directory, &self.output(&record)?)?;
        let exit = read_exit(&directory, process)?;
        let complete = reader.complete()?;
        if record.fenced() {
            if let (Some(exit), Some(sequence)) = (exit, complete) {
                return Ok(self.observation(
                    record.id(),
                    WorkerState::Drained {
                        process: process.clone(),
                        exit,
                        sequence,
                    },
                ));
            }
            return Ok(self.receipt(&record));
        }
        let state = match facts.as_slice() {
            [GateRecord::Ready { .. }, GateRecord::Released { digest }]
                if record.stage() == Some(LaunchStage::Release)
                    && digest == &record.command().ok_or(Error::Conflict)?.digest()? =>
            {
                WorkerState::Running {
                    process: process.clone(),
                }
            }
            [GateRecord::Ready { .. }] => WorkerState::Attached {
                process: process.clone(),
            },
            [GateRecord::Ready { .. }, GateRecord::Refused] => WorkerState::Accepted,
            _ => return Err(Error::Conflict),
        };
        Ok(self.observation(record.id(), state))
    }
    async fn event(&self, start: &WorkerStart, event: &WorkerEvent) -> Result<Snapshot> {
        self.external(
            start,
            self.control
                .event(&start.callback, start.id, self.journal.worker(), event),
        )
        .await
    }
    async fn external<T>(
        &self,
        start: &WorkerStart,
        future: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        let record = self.journal.get(start.id).await?.ok_or(Error::NotFound)?;
        let remaining = if !record.stopped() && !record.fenced() {
            record.remaining()?
        } else {
            None
        };
        let request = Duration::from_millis(start.settings.request_timeout_ms);
        let result = tokio::time::timeout(
            remaining.map_or(request, |remaining| remaining.min(request)),
            future,
        )
        .await;
        if remaining.is_some()
            && self
                .journal
                .get(start.id)
                .await?
                .ok_or(Error::NotFound)?
                .expired()?
        {
            self.stop(start.id).await?;
        }
        result.map_err(|_| Error::Unavailable {
            retry_after_ms: start.settings.poll_after_ms,
        })?
    }
    fn output(&self, record: &WorkerRecord) -> Result<CaptureOptions> {
        Ok(CaptureOptions {
            id: record.id(),
            worker: self.journal.worker(),
            frame_bytes: NonZeroUsize::new(
                record.start().ok_or(Error::Conflict)?.settings.frame_bytes,
            )
            .ok_or(Error::Invalid)?,
            key: self.output_key.clone(),
        })
    }
    fn receipt(&self, record: &WorkerRecord) -> WorkerObservation {
        self.observation(
            record.id(),
            record.terminal().cloned().unwrap_or(WorkerState::Accepted),
        )
    }
    fn observation(&self, id: JobId, state: WorkerState) -> WorkerObservation {
        WorkerObservation {
            id,
            worker: self.journal.worker(),
            state,
        }
    }
    fn directory(&self, id: JobId) -> PathBuf {
        self.journal
            .directory()
            .join("operations")
            .join(id.scope.to_string())
            .join(id.operation.to_string())
    }
    fn reserve(&self, id: JobId) -> Result<PathBuf> {
        let operations = self.journal.directory().join("operations");
        ensure_directory(&operations)?;
        File::open(self.journal.directory())?.sync_all()?;
        let scope = operations.join(id.scope.to_string());
        ensure_directory(&scope)?;
        File::open(&operations)?.sync_all()?;
        let directory = self.directory(id);
        fs::create_dir(&directory)?;
        File::open(scope)?.sync_all()?;
        Ok(directory)
    }
}
fn ensure_directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists
                && fs::metadata(path)?.is_dir() => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
