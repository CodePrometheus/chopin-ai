//! Host-selected transactions and persistence for the encrypted command ledger.

mod postgres;
mod sqlite;

use async_trait::async_trait;
use sqlx::{PgPool, Postgres, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::{JobId, Result};

/// Initial immutable SQLite ledger schema, applied in the host's migration transaction.
pub const SQLITE_SCHEMA_V1: &str = include_str!("storage/sqlite.sql");

/// The host's coordination database, shared by command records and host authorization.
#[derive(Clone, Debug)]
pub enum LedgerStore {
    /// A host-configured PostgreSQL pool.
    Postgres(PgPool),
    /// A file-backed SQLite pool with WAL, synchronous full commits and foreign keys enabled.
    Sqlite(SqlitePool),
}

impl LedgerStore {
    /// Begin a short coordination transaction on the host's database.
    pub async fn begin(&self) -> Result<StoreTransaction<'static>> {
        match self {
            Self::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                sqlx::query("SET LOCAL synchronous_commit='on'")
                    .execute(&mut *tx)
                    .await?;
                Ok(StoreTransaction::Postgres(tx))
            }
            Self::Sqlite(pool) => {
                let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
                sqlite::durable(&mut tx).await?;
                Ok(StoreTransaction::Sqlite(tx))
            }
        }
    }
}

/// An open transaction shared by host authorization and command storage.
#[derive(Debug)]
pub enum StoreTransaction<'a> {
    /// A transaction on the host's PostgreSQL coordination database.
    Postgres(Transaction<'a, Postgres>),
    /// A transaction on the host's SQLite coordination database.
    /// For writes, the host must acquire the writer reservation before reading authority.
    Sqlite(Transaction<'a, Sqlite>),
}

impl StoreTransaction<'_> {
    /// Persist all host and ledger writes together.
    pub async fn commit(self) -> Result<()> {
        match self {
            Self::Postgres(tx) => tx.commit().await?,
            Self::Sqlite(tx) => tx.commit().await?,
        }
        Ok(())
    }

    /// Discard all writes in this transaction.
    pub async fn rollback(self) -> Result<()> {
        match self {
            Self::Postgres(tx) => tx.rollback().await?,
            Self::Sqlite(tx) => tx.rollback().await?,
        }
        Ok(())
    }
}

/// A ledger transaction, implemented for both native database transactions and the host wrapper.
pub trait LedgerTransaction: Send {
    /// The storage adapter operating within this transaction.
    fn storage(&mut self) -> &mut dyn LedgerStorage;
}

impl LedgerTransaction for Transaction<'_, Postgres> {
    fn storage(&mut self) -> &mut dyn LedgerStorage {
        &mut **self
    }
}

impl LedgerTransaction for Transaction<'_, Sqlite> {
    fn storage(&mut self) -> &mut dyn LedgerStorage {
        &mut **self
    }
}

impl LedgerTransaction for StoreTransaction<'_> {
    fn storage(&mut self) -> &mut dyn LedgerStorage {
        match self {
            Self::Postgres(tx) => tx.storage(),
            Self::Sqlite(tx) => tx.storage(),
        }
    }
}

/// Encrypted command content, encrypted state and its revision, in that order.
pub type SealedRecord = (Vec<u8>, Vec<u8>, i64);

/// Persistence operations for encrypted command records and output within one transaction.
///
/// Keep all writes atomic through transaction commit. The ledger owns encryption,
/// request identity checks, state transitions and cursor validation.
#[async_trait]
pub trait LedgerStorage: Send {
    /// Verify that this transaction can durably persist command facts.
    async fn durable(&mut self) -> Result<()>;

    /// Insert a new command at revision one. Return false if its identity is already recorded.
    async fn insert(
        &mut self,
        id: JobId,
        content: Vec<u8>,
        state: Vec<u8>,
        drained: bool,
    ) -> Result<bool>;

    /// Read a command, serializing concurrent writes when a write lock is requested.
    /// A backend may acquire the write lock at transaction start.
    async fn read(&mut self, id: JobId, lock: bool) -> Result<Option<SealedRecord>>;

    /// Replace state only at the expected previous revision, returning whether it matched.
    async fn update(
        &mut self,
        id: JobId,
        state: Vec<u8>,
        revision: i64,
        drained: bool,
        previous: i64,
    ) -> Result<bool>;

    /// Insert the encrypted bytes for one output sequence.
    async fn insert_frame(&mut self, id: JobId, sequence: i64, sealed: Vec<u8>) -> Result<()>;

    /// Read the encrypted bytes for one output sequence.
    async fn frame(&mut self, id: JobId, sequence: i64) -> Result<Option<Vec<u8>>>;

    /// Report whether the scope has any commands that have yet to drain.
    async fn has_pending(&mut self, scope: Uuid) -> Result<bool>;

    /// Return up to count undrained operations in ascending order, strictly after the cursor.
    async fn pending(&mut self, scope: Uuid, after: Option<Uuid>, count: i64) -> Result<Vec<Uuid>>;
}
