use std::{future::Future, num::NonZeroUsize, sync::Arc, time::Duration};

use sqlx::PgPool;
use url::Url;
use uuid::Uuid;

use crate::coordination::{PostgresAuthority, SqlBrokerStore};
use crate::{
    Action, Admission, BrokerStore, BrokerTransaction, Callback, Caller, Error, HostAuthority,
    JobId, Ledger, LedgerStore, OutputPage, Phase, Record, Request, Result, Settings, Snapshot,
    TransactionalHostAuthority, WorkerAction, WorkerCaller, WorkerEndpoint, WorkerEvent,
    WorkerObservation, WorkerStart, WorkerState, WorkerTransport,
};

/// Coordinates durable intent and exact worker effects without holding a transaction across I/O.
pub struct Broker {
    store: Arc<dyn BrokerStore>,
    ledger: Ledger,
    worker: Arc<dyn WorkerTransport>,
    settings: Settings,
    callback: Url,
}
impl std::fmt::Debug for Broker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Broker")
            .field("settings", &self.settings)
            .finish_non_exhaustive()
    }
}
impl Broker {
    /// Binds explicit host authority, worker transport and policy; creates no external resources.
    pub fn new(
        pool: PgPool,
        ledger: Ledger,
        authority: Arc<dyn HostAuthority>,
        worker: Arc<dyn WorkerTransport>,
        settings: Settings,
        callback: &str,
    ) -> Result<Self> {
        Self::with_ledger(
            LedgerStore::Postgres(pool),
            ledger,
            Arc::new(PostgresAuthority(authority)),
            worker,
            settings,
            callback,
        )
    }

    /// Uses a built-in coordination database and host authority sharing the same transaction.
    pub fn with_ledger(
        store: LedgerStore,
        ledger: Ledger,
        authority: Arc<dyn TransactionalHostAuthority>,
        worker: Arc<dyn WorkerTransport>,
        settings: Settings,
        callback: &str,
    ) -> Result<Self> {
        Self::with_store(
            Arc::new(SqlBrokerStore {
                ledger: store,
                authority,
            }),
            ledger,
            worker,
            settings,
            callback,
        )
    }

    /// Uses a host-supplied provider for command and authorization transactions.
    pub fn with_store(
        store: Arc<dyn BrokerStore>,
        ledger: Ledger,
        worker: Arc<dyn WorkerTransport>,
        settings: Settings,
        callback: &str,
    ) -> Result<Self> {
        settings.validate()?;
        Ok(Self {
            store,
            ledger,
            worker,
            settings,
            callback: crate::worker::address(callback)?,
        })
    }

    /// Accept an immutable command, then prepare its original worker. A lost response is reconciled by ID.
    pub async fn submit(
        &self,
        caller: &Caller,
        operation: Uuid,
        request: &Request,
    ) -> Result<Snapshot> {
        let mut tx = self.begin().await?;
        let (record, inserted) = self
            .ledger
            .record(
                &mut *tx,
                caller,
                operation,
                request,
                Admission::Execute(&self.settings),
            )
            .await?;
        tx.authorize(
            caller,
            record.request(),
            if inserted {
                Action::Submit
            } else {
                Action::Read
            },
        )
        .await?;
        tx.commit().await?;
        if !inserted || record.state().phase == Phase::Drained {
            return Ok(record.snapshot());
        }
        self.reconcile(caller, operation).await
    }

    /// Persist cancellation even before submission; a later submit cannot start that identity.
    pub async fn cancel(
        &self,
        caller: &Caller,
        operation: Uuid,
        request: &Request,
    ) -> Result<Snapshot> {
        let mut tx = self.begin().await?;
        let (mut record, _) = self
            .ledger
            .record(
                &mut *tx,
                caller,
                operation,
                request,
                Admission::Cancel(&self.settings),
            )
            .await?;
        tx.authorize(caller, record.request(), Action::Stop).await?;
        self.ledger.stop(&mut *tx, &mut record).await?;
        tx.commit().await?;
        if record.state().worker.is_none() {
            return Ok(record.snapshot());
        }
        self.reconcile(caller, operation).await
    }

    /// Read original ledger facts under current ownership; missing observation is never terminal state.
    pub async fn get(&self, caller: &Caller, operation: Uuid) -> Result<Snapshot> {
        let mut tx = self.begin().await?;
        let record = self
            .authorized(&mut *tx, caller, operation, Action::Read)
            .await?;
        tx.commit().await?;
        Ok(record.snapshot())
    }

    /// Persist stop before contacting the original worker, retaining it after timeout or disconnect.
    pub async fn stop(&self, caller: &Caller, operation: Uuid) -> Result<Snapshot> {
        let mut tx = self.begin().await?;
        let mut record = self
            .authorized(&mut *tx, caller, operation, Action::Stop)
            .await?;
        self.ledger.stop(&mut *tx, &mut record).await?;
        tx.commit().await?;
        if record.state().phase == Phase::Drained {
            return Ok(record.snapshot());
        }
        self.reconcile(caller, operation).await
    }

    /// Read an operation-bound output page under the original policy and current ownership.
    pub async fn output(
        &self,
        caller: &Caller,
        operation: Uuid,
        cursor: Option<&str>,
        bytes: NonZeroUsize,
    ) -> Result<OutputPage> {
        let mut tx = self.begin().await?;
        let record = self
            .authorized(&mut *tx, caller, operation, Action::Read)
            .await?;
        let page = self.ledger.output(&mut *tx, &record, cursor, bytes).await?;
        tx.commit().await?;
        Ok(page)
    }

    /// Authenticate and persist one original worker fact; release checks current authority every time.
    pub async fn worker_event(
        &self,
        caller: &WorkerCaller,
        event: WorkerEvent,
    ) -> Result<Snapshot> {
        let mut tx = self.begin().await?;
        let mut record = self.callback_record(&mut *tx, caller).await?;
        let action = if matches!(event, WorkerEvent::Release) {
            WorkerAction::Release
        } else {
            WorkerAction::Observe
        };
        tx.authorize_worker(caller, record.request(), action)
            .await?;
        self.ledger
            .event(&mut *tx, &mut record, caller.worker, &event)
            .await?;
        tx.commit().await?;
        Ok(record.snapshot())
    }

    /// Reconcile a persisted original operation; start only after a positive absence observation.
    /// Host recovery and client retries call this with the currently authenticated owner runtime.
    pub async fn reconcile(&self, caller: &Caller, operation: Uuid) -> Result<Snapshot> {
        let mut tx = self.begin().await?;
        let record = self
            .authorized(&mut *tx, caller, operation, Action::Read)
            .await?;
        tx.commit().await?;
        if record.state().phase == Phase::Drained {
            return Ok(record.snapshot());
        }
        let endpoint = self
            .external(
                record.settings(),
                self.worker
                    .locate(caller, record.request(), record.state().worker),
            )
            .await?;
        let mut tx = self.begin().await?;
        let mut record = self
            .authorized(&mut *tx, caller, operation, Action::Read)
            .await?;
        if record.state().phase == Phase::Drained {
            tx.commit().await?;
            return Ok(record.snapshot());
        }
        if record.state().worker.is_none() {
            tx.authorize(caller, record.request(), Action::Submit)
                .await?;
            self.ledger
                .reserve(&mut *tx, &mut record, endpoint.worker())
                .await?;
        } else if record.state().worker != Some(endpoint.worker()) {
            return Err(Error::Conflict);
        }
        tx.commit().await?;
        if record.state().stop_requested {
            let observed = self
                .external(record.settings(), self.worker.stop(&endpoint, record.id()))
                .await?;
            self.observed(caller, record.id(), &endpoint, observed)
                .await?;
        } else {
            match self
                .external(
                    record.settings(),
                    self.worker.observe(&endpoint, record.id()),
                )
                .await?
            {
                Some(observed) => {
                    self.observed(caller, record.id(), &endpoint, observed)
                        .await?
                }
                None => {
                    if record.state().process.is_some() || record.state().released {
                        return Err(Error::Conflict);
                    }
                    let launch = self.launch(caller, operation, &endpoint).await?;
                    if let Some(launch) = launch {
                        let observed = self
                            .external(&launch.settings, self.worker.start(&endpoint, &launch))
                            .await?;
                        self.observed(caller, record.id(), &endpoint, observed)
                            .await?;
                    } else {
                        let observed = self
                            .external(record.settings(), self.worker.stop(&endpoint, record.id()))
                            .await?;
                        self.observed(caller, record.id(), &endpoint, observed)
                            .await?;
                    }
                }
            }
        }
        self.get(caller, operation).await
    }

    async fn launch(
        &self,
        caller: &Caller,
        operation: Uuid,
        endpoint: &WorkerEndpoint,
    ) -> Result<Option<WorkerStart>> {
        let mut tx = self.begin().await?;
        let record = self
            .authorized(&mut *tx, caller, operation, Action::Read)
            .await?;
        if record.state().worker != Some(endpoint.worker()) {
            return Err(Error::Conflict);
        }
        if record.state().stop_requested || record.state().phase == Phase::Drained {
            tx.commit().await?;
            return Ok(None);
        }
        tx.authorize(caller, record.request(), Action::Submit)
            .await?;
        let callback = Callback {
            url: self
                .callback
                .join(&format!("{operation}/worker"))
                .map_err(|_| Error::Invalid)?
                .to_string(),
            credential: self.store.worker_credential(
                record.caller(),
                record.id(),
                endpoint.worker(),
            )?,
        };
        let launch = WorkerStart {
            version: 1,
            id: record.id(),
            request: record.request().clone(),
            settings: record.settings().clone(),
            callback,
        };
        tx.commit().await?;
        Ok(Some(launch))
    }

    async fn observed(
        &self,
        caller: &Caller,
        expected: JobId,
        endpoint: &WorkerEndpoint,
        observed: WorkerObservation,
    ) -> Result<()> {
        if observed.id != expected
            || observed.id.scope != caller.scope
            || observed.worker != endpoint.worker()
        {
            return Err(Error::Conflict);
        }
        let mut tx = self.begin().await?;
        let mut record = self
            .authorized(&mut *tx, caller, observed.id.operation, Action::Read)
            .await?;
        if record.state().worker != Some(endpoint.worker()) {
            return Err(Error::Conflict);
        }
        let original = WorkerCaller {
            caller: record.caller().clone(),
            operation: record.id().operation,
            worker: endpoint.worker(),
        };
        tx.authorize_worker(&original, record.request(), WorkerAction::Observe)
            .await?;
        let process = match &observed.state {
            WorkerState::Attached { process }
            | WorkerState::Running { process }
            | WorkerState::Drained { process, .. } => Some(process),
            _ => None,
        };
        if let Some(process) = process {
            self.ledger
                .event(
                    &mut *tx,
                    &mut record,
                    endpoint.worker(),
                    &WorkerEvent::Attached {
                        process: process.clone(),
                    },
                )
                .await?;
        }
        match observed.state {
            WorkerState::Accepted => {}
            WorkerState::Attached { .. } => {}
            WorkerState::Running { .. } => {
                self.ledger
                    .event(
                        &mut *tx,
                        &mut record,
                        endpoint.worker(),
                        &WorkerEvent::Started,
                    )
                    .await?
            }
            WorkerState::Cancelled => {
                self.ledger
                    .event(
                        &mut *tx,
                        &mut record,
                        endpoint.worker(),
                        &WorkerEvent::NotStarted,
                    )
                    .await?
            }
            WorkerState::Drained {
                process,
                exit,
                sequence,
            } => {
                if sequence < record.state().last_sequence {
                    return Err(Error::Conflict);
                }
                self.ledger
                    .event(
                        &mut *tx,
                        &mut record,
                        endpoint.worker(),
                        &WorkerEvent::Exited { exit },
                    )
                    .await?;
                if sequence == record.state().last_sequence {
                    self.ledger
                        .event(
                            &mut *tx,
                            &mut record,
                            endpoint.worker(),
                            &WorkerEvent::OutputComplete { sequence },
                        )
                        .await?;
                    self.ledger
                        .event(
                            &mut *tx,
                            &mut record,
                            endpoint.worker(),
                            &WorkerEvent::Drained { process, sequence },
                        )
                        .await?;
                }
            }
        }
        tx.commit().await?;
        Ok(())
    }

    async fn external<T>(
        &self,
        settings: &Settings,
        work: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        tokio::time::timeout(Duration::from_millis(settings.request_timeout_ms), work)
            .await
            .map_err(|_| Error::Unavailable {
                retry_after_ms: settings.poll_after_ms,
            })?
    }

    pub(crate) async fn begin(&self) -> Result<Box<dyn BrokerTransaction + '_>> {
        self.store.begin().await
    }
    async fn authorized(
        &self,
        tx: &mut dyn BrokerTransaction,
        caller: &Caller,
        operation: Uuid,
        action: Action,
    ) -> Result<Record> {
        if caller.scope.is_nil() || operation.is_nil() {
            return Err(Error::Invalid);
        }
        let record = self
            .ledger
            .read(
                tx,
                JobId {
                    scope: caller.scope,
                    operation,
                },
            )
            .await?
            .ok_or(Error::NotFound)?;
        tx.authorize(caller, record.request(), action).await?;
        Ok(record)
    }
    pub(crate) async fn callback_record(
        &self,
        tx: &mut dyn BrokerTransaction,
        caller: &WorkerCaller,
    ) -> Result<Record> {
        let record = self
            .ledger
            .read(
                tx,
                JobId {
                    scope: caller.caller.scope,
                    operation: caller.operation,
                },
            )
            .await?
            .ok_or(Error::NotFound)?;
        if record.caller() != &caller.caller || record.state().worker != Some(caller.worker) {
            return Err(Error::Forbidden);
        }
        Ok(record)
    }
    #[cfg(feature = "transport")]
    pub(crate) fn store(&self) -> &dyn BrokerStore {
        self.store.as_ref()
    }
    #[cfg(feature = "transport")]
    pub(crate) fn settings(&self) -> &Settings {
        &self.settings
    }
}

/// Reconciliation result for one original operation; errors retain its pending intent.
#[derive(Debug)]
pub struct RecoveryResult {
    /// Original operation checked in this pass.
    pub operation_id: Uuid,
    /// Fresh ledger state or the explicit failure to establish it.
    pub result: Result<Snapshot>,
}
/// One recoverable page, allowing the host to pace and cancel its own background work.
#[derive(Debug)]
pub struct RecoveryPage {
    /// Each selected operation's observed outcome; no failed operation is silently dropped.
    pub outcomes: Vec<RecoveryResult>,
    /// Original source cursor, scoped to the current authenticated caller.
    pub cursor: Option<String>,
}
impl Broker {
    /// Whether this scope retains command work; an authorization or store failure stays an error.
    pub async fn has_pending(&self, caller: &Caller) -> Result<bool> {
        let mut tx = self.begin().await?;
        tx.authorize_scope(caller).await?;
        let pending = self.ledger.has_pending(&mut *tx, caller.scope).await?;
        tx.commit().await?;
        Ok(pending)
    }
    /// Recover one source page using original identities. The host owns cadence and cancellation.
    pub async fn recover(
        &self,
        caller: &Caller,
        limit: NonZeroUsize,
        cursor: Option<&str>,
    ) -> Result<RecoveryPage> {
        let mut tx = self.begin().await?;
        tx.authorize_scope(caller).await?;
        let page = self
            .ledger
            .pending(&mut *tx, caller.scope, limit, cursor)
            .await?;
        tx.commit().await?;
        let mut outcomes = Vec::with_capacity(page.operations.len());
        for operation_id in page.operations {
            outcomes.push(RecoveryResult {
                operation_id,
                result: self.reconcile(caller, operation_id).await,
            });
        }
        Ok(RecoveryPage {
            outcomes,
            cursor: page.cursor,
        })
    }
}
