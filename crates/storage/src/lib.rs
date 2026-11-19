//! Encrypted disk-backed execution data and its transactional content commitment.
//!
//! The execution adapter owns external freshness preparation and confirmation.
//! A successful local commit alone must never acknowledge durable execution.

mod connection;
mod content;
mod error;
mod metadata;
mod schema;
mod transaction;

use connection::{Scope, connect, query, writer_lock};
use content::Tree;
use metadata::{Metadata, head, load, save};
use rusqlite::{Connection, types::Value};
use schema::Schema;
use std::{
    cell::Cell,
    fs::{File, OpenOptions},
    num::NonZeroU32,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

pub use error::{Error, Result};
pub use transaction::Transaction;

/// Explicit host settings; absent tuning fields preserve database-engine defaults.
#[derive(Clone, Debug, Default)]
pub struct Options {
    /// Override the pager cache budget in kibibytes.
    pub cache_kib: Option<NonZeroU32>,
    /// Override how long this connection waits for a database lock.
    pub busy_timeout: Option<Duration>,
}

/// An authenticated logical storage head, suitable for external freshness checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Head {
    /// Monotonic transaction sequence, committed atomically with the actual data.
    pub sequence: u64,
    /// Commitment to the store identity, sequence, schema, and complete row content.
    pub digest: [u8; 32],
}

/// A prepared local transaction; external preparation must precede local commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Prepared {
    /// Previously confirmed local state.
    pub previous: Head,
    /// Exact successor whose local result must be reconciled after uncertainty.
    pub next: Head,
}

/// One exclusive encrypted connection. Run it on a dedicated connection thread.
pub struct Database {
    connection: Connection,
    schema: Schema,
    privileged: Arc<AtomicBool>,
    poisoned: Cell<bool>,
    _writer: File,
}

impl std::fmt::Debug for Database {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Database")
            .field("poisoned", &self.poisoned.get())
            .finish_non_exhaustive()
    }
}

impl Database {
    /// Creates a new store exclusively. Existing paths, including empty files, are refused.
    ///
    /// The host must persist its allocation and key before calling this method.
    /// On failure retain the original path and reconcile initialization explicitly.
    pub fn create(path: &Path, key: &[u8; 32], options: &Options) -> Result<Self> {
        let writer = writer_lock(path)?;
        Self::new_file(path)?;
        Self::bootstrap(path, connect(path, key, options)?, writer)
    }

    /// Continues the original protected initialization without replacing existing data.
    ///
    /// Only an admitted initializer may call this method. The host must first
    /// establish that no independent freshness record already requires missing
    /// history. Nonempty databases are verified as existing stores, never reset.
    pub fn initialize(path: &Path, key: &[u8; 32], options: &Options) -> Result<Self> {
        let writer = writer_lock(path)?;
        match Self::new_file(path) {
            Ok(()) => {}
            Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let connection = connect(path, key, options)?;
        let empty: bool = connection.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema)",
            [],
            |row| row.get(0),
        )?;
        if empty {
            Self::bootstrap(path, connection, writer)
        } else {
            Self::verify(connection, writer)
        }
    }

    fn new_file(path: &Path) -> Result<()> {
        let mut file = OpenOptions::new();
        file.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            file.mode(0o600);
        }
        file.open(path)?.sync_all()?;
        Ok(())
    }

    fn bootstrap(path: &Path, connection: Connection, writer: File) -> Result<Self> {
        connection.execute_batch("BEGIN IMMEDIATE")?;
        connection.execute_batch(include_str!("schema.sql"))?;
        let schema = Schema::read(&connection)?;
        let mut identity = [0; 32];
        getrandom::fill(&mut identity).map_err(|_| Error::Randomness)?;
        let root = Tree {
            connection: &connection,
            epoch: 0,
        }
        .apply(0, [])?;
        let metadata = Metadata {
            head: head(identity, 0, schema.digest, root.0),
            identity,
            schema: schema.digest,
            epoch: 0,
            version: 0,
        };
        save(&connection, &metadata)?;
        connection.execute_batch("COMMIT")?;
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
        Self::from_connection(connection, schema, writer)
    }

    /// Opens existing encrypted data and verifies actual rows against their authenticated head.
    ///
    /// This never initializes a missing store. The returned local head still requires
    /// reconciliation with the host's independent freshness record before execution resumes.
    pub fn open(path: &Path, key: &[u8; 32], options: &Options) -> Result<Self> {
        let writer = writer_lock(path)?;
        let connection = connect(path, key, options)?;
        Self::verify(connection, writer)
    }

    fn verify(connection: Connection, writer: File) -> Result<Self> {
        let metadata = load(&connection)?;
        let schema = Schema::read(&connection)?;
        if schema.digest != metadata.schema {
            return Err(Error::Integrity);
        }
        let tree = Tree {
            connection: &connection,
            epoch: metadata.epoch,
        };
        let root = tree.root(metadata.version)?;
        if head(
            metadata.identity,
            metadata.head.sequence,
            schema.digest,
            root.0,
        ) != metadata.head
        {
            return Err(Error::Integrity);
        }
        tree.verify(metadata.version, &schema)?;
        Self::from_connection(connection, schema, writer)
    }

    /// Reads the current local head; this does not assert independent host confirmation.
    pub fn head(&self) -> Result<Head> {
        Ok(load(&self.connection)?.head)
    }

    /// Runs a read-only statement. Rows contain exact integers and owned text or binary values.
    pub fn query(&self, sql: &str, values: &[Value]) -> Result<Rows> {
        self.healthy()?;
        let _scope = Scope::new(&self.privileged);
        query(&self.connection, sql, values)
    }

    /// Flushes and closes this connection before releasing its exclusive writer lock.
    pub fn close(self) -> Result<()> {
        self.connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        self.connection
            .close()
            .map_err(|(_, error)| Error::Database(error))
    }

    fn healthy(&self) -> Result<()> {
        if self.poisoned.get() {
            Err(Error::RecoveryRequired)
        } else {
            Ok(())
        }
    }
}

/// Owned query results; SQL paging remains the trusted caller's responsibility.
#[derive(Debug)]
pub struct Rows {
    /// Column names in statement order.
    pub columns: Vec<String>,
    /// Actual database rows, preserving null, integer, real, text, and binary types.
    pub values: Vec<Vec<Value>>,
}
