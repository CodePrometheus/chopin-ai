//! The broker's host boundary for authorization and command persistence.

use std::sync::Arc;

use async_trait::async_trait;

use crate::{
    Action, Caller, Credential, Error, HostAuthority, JobId, LedgerStorage, LedgerStore,
    LedgerTransaction, Request, Result, StoreTransaction, TransactionalHostAuthority, WorkerAction,
    WorkerCaller,
};
use uuid::Uuid;

/// Host-provided transaction source and credential adapter for the command broker.
#[async_trait]
pub trait BrokerStore: Send + Sync {
    /// Begin one transaction shared by authorization and command storage.
    async fn begin(&self) -> Result<Box<dyn BrokerTransaction + '_>>;

    /// Authenticate an execution credential.
    async fn authenticate(&self, credential: &str) -> Result<Caller>;

    /// Authenticate an exact worker callback identity.
    async fn authenticate_worker(&self, credential: &str) -> Result<WorkerCaller>;

    /// Issue a purpose-bound callback credential for a reserved worker.
    fn worker_credential(&self, caller: &Caller, id: JobId, worker: Uuid) -> Result<Credential>;
}

/// Atomic authorization and ledger operations. Dropping without committing rolls back all writes.
#[async_trait]
pub trait BrokerTransaction: LedgerTransaction {
    /// Verify current ownership of an entire scope.
    async fn authorize_scope(&mut self, caller: &Caller) -> Result<()>;

    /// Verify the caller's current ownership and permission for the command.
    async fn authorize(&mut self, caller: &Caller, request: &Request, action: Action)
    -> Result<()>;

    /// Verify a worker's binding and the current execution permission for release.
    async fn authorize_worker(
        &mut self,
        caller: &WorkerCaller,
        request: &Request,
        action: WorkerAction,
    ) -> Result<()>;

    /// Commit the authorization and ledger writes before any external effects.
    async fn commit(self: Box<Self>) -> Result<()>;
}

pub(crate) struct SqlBrokerStore {
    pub(crate) ledger: LedgerStore,
    pub(crate) authority: Arc<dyn TransactionalHostAuthority>,
}

#[async_trait]
impl BrokerStore for SqlBrokerStore {
    async fn begin(&self) -> Result<Box<dyn BrokerTransaction + '_>> {
        Ok(Box::new(SqlBrokerTransaction {
            tx: self.ledger.begin().await?,
            authority: self.authority.as_ref(),
        }))
    }

    async fn authenticate(&self, credential: &str) -> Result<Caller> {
        self.authority.authenticate(credential).await
    }

    async fn authenticate_worker(&self, credential: &str) -> Result<WorkerCaller> {
        self.authority.authenticate_worker(credential).await
    }

    fn worker_credential(&self, caller: &Caller, id: JobId, worker: Uuid) -> Result<Credential> {
        self.authority.worker_credential(caller, id, worker)
    }
}

struct SqlBrokerTransaction<'a> {
    tx: StoreTransaction<'static>,
    authority: &'a dyn TransactionalHostAuthority,
}

impl LedgerTransaction for SqlBrokerTransaction<'_> {
    fn storage(&mut self) -> &mut dyn LedgerStorage {
        self.tx.storage()
    }
}

#[async_trait]
impl BrokerTransaction for SqlBrokerTransaction<'_> {
    async fn authorize_scope(&mut self, caller: &Caller) -> Result<()> {
        self.authority.authorize_scope(&mut self.tx, caller).await
    }

    async fn authorize(
        &mut self,
        caller: &Caller,
        request: &Request,
        action: Action,
    ) -> Result<()> {
        self.authority
            .authorize(&mut self.tx, caller, request, action)
            .await
    }

    async fn authorize_worker(
        &mut self,
        caller: &WorkerCaller,
        request: &Request,
        action: WorkerAction,
    ) -> Result<()> {
        self.authority
            .authorize_worker(&mut self.tx, caller, request, action)
            .await
    }

    async fn commit(self: Box<Self>) -> Result<()> {
        self.tx.commit().await
    }
}

pub(crate) struct PostgresAuthority(pub(crate) Arc<dyn HostAuthority>);

#[async_trait]
impl TransactionalHostAuthority for PostgresAuthority {
    async fn authenticate(&self, credential: &str) -> Result<Caller> {
        self.0.authenticate(credential).await
    }

    async fn authenticate_worker(&self, credential: &str) -> Result<WorkerCaller> {
        self.0.authenticate_worker(credential).await
    }

    async fn authorize_scope(&self, tx: &mut StoreTransaction<'_>, caller: &Caller) -> Result<()> {
        let StoreTransaction::Postgres(tx) = tx else {
            return Err(Error::Invalid);
        };
        self.0.authorize_scope(tx, caller).await
    }

    async fn authorize(
        &self,
        tx: &mut StoreTransaction<'_>,
        caller: &Caller,
        request: &Request,
        action: Action,
    ) -> Result<()> {
        let StoreTransaction::Postgres(tx) = tx else {
            return Err(Error::Invalid);
        };
        self.0.authorize(tx, caller, request, action).await
    }

    async fn authorize_worker(
        &self,
        tx: &mut StoreTransaction<'_>,
        caller: &WorkerCaller,
        request: &Request,
        action: WorkerAction,
    ) -> Result<()> {
        let StoreTransaction::Postgres(tx) = tx else {
            return Err(Error::Invalid);
        };
        self.0.authorize_worker(tx, caller, request, action).await
    }

    fn worker_credential(&self, caller: &Caller, id: JobId, worker: Uuid) -> Result<Credential> {
        self.0.worker_credential(caller, id, worker)
    }
}
