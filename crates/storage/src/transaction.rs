use crate::{
    Database, Error, Head, Prepared, Result, Rows,
    connection::{Scope, query},
    content::{Tree, as_integer},
    metadata::{Metadata, head, load, save},
    schema::{PREFIX, Schema},
};
use rusqlite::{
    Connection,
    session::Session,
    types::{Value, ValueRef},
};
use std::{
    cell::Cell,
    collections::BTreeMap,
    sync::{Arc, atomic::AtomicBool},
};

impl Database {
    /// Begins the only transaction on this connection.
    ///
    /// Dropping the transaction rolls it back. Rollback failure poisons the
    /// connection; the caller must reopen and reconcile before acknowledging work.
    pub fn begin(&mut self) -> Result<Transaction<'_>> {
        self.healthy()?;
        self.connection.execute_batch("BEGIN IMMEDIATE")?;
        let opened = (|| {
            let metadata = load(&self.connection)?;
            let mut session = Session::new(&self.connection)?;
            session.table_filter(Some(|name: &str| !name.starts_with(PREFIX)));
            session.attach::<&str>(None)?;
            Ok::<_, Error>((metadata, session))
        })();
        match opened {
            Ok((metadata, session)) => Ok(Transaction {
                connection: &self.connection,
                schema: &mut self.schema,
                privileged: &self.privileged,
                poisoned: &self.poisoned,
                session,
                previous: metadata,
                updated: None,
                prepared: None,
                failed: false,
                active: true,
            }),
            Err(error) => {
                if self.connection.execute_batch("ROLLBACK").is_err() {
                    self.poisoned.set(true);
                    return Err(Error::RecoveryRequired);
                }
                Err(error)
            }
        }
    }
}

/// An exclusive local transaction, including its incremental content commitment.
pub struct Transaction<'a> {
    connection: &'a Connection,
    schema: &'a mut Schema,
    privileged: &'a Arc<AtomicBool>,
    poisoned: &'a Cell<bool>,
    session: Session<'a>,
    previous: Metadata,
    updated: Option<Schema>,
    prepared: Option<Prepared>,
    failed: bool,
    active: bool,
}

impl std::fmt::Debug for Transaction<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Transaction")
            .field("prepared", &self.prepared.is_some())
            .field("active", &self.active)
            .finish_non_exhaustive()
    }
}

impl Transaction<'_> {
    /// Executes trusted schema statements in the current transaction.
    pub fn exec(&self, sql: &str) -> Result<()> {
        self.writable()?;
        let _scope = Scope::new(self.privileged);
        self.connection.execute_batch(sql)?;
        Ok(())
    }

    /// Executes one bound statement and returns the database's actual affected-row count.
    pub fn run(&self, sql: &str, values: &[Value]) -> Result<u64> {
        self.writable()?;
        let _scope = Scope::new(self.privileged);
        let changed = self
            .connection
            .prepare_cached(sql)?
            .execute(rusqlite::params_from_iter(values))?;
        Ok(changed as u64)
    }

    /// Reads through this transaction without admitting unrelated connection work.
    pub fn query(&self, sql: &str, values: &[Value]) -> Result<Rows> {
        self.writable()?;
        let _scope = Scope::new(self.privileged);
        query(self.connection, sql, values)
    }

    /// Commits the exact content commitment inside the still-uncommitted SQL transaction.
    ///
    /// Only after the external host prepares this successor may the caller commit
    /// locally. Repeated preparation returns the same pair and permits no new SQL.
    pub fn prepare(&mut self) -> Result<Prepared> {
        if let Some(prepared) = self.prepared {
            return Ok(prepared);
        }
        self.writable()?;
        let result = self.prepare_content();
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn prepare_content(&mut self) -> Result<Prepared> {
        let revision: i64 = self
            .connection
            .query_row("PRAGMA schema_version", [], |row| row.get(0))?;
        let schema_changed = revision != self.schema.revision;
        if schema_changed {
            self.updated = Some(Schema::read(self.connection)?);
        }
        let schema = self.updated.as_ref().unwrap_or(self.schema);
        let mut next = self.previous.clone();
        let root = if schema_changed {
            next.epoch = next.epoch.checked_add(1).ok_or(Error::SequenceExhausted)?;
            next.version = 0;
            let tree = Tree {
                connection: self.connection,
                epoch: next.epoch,
            };
            let mut root = tree.apply(0, [])?;
            schema.rows(self.connection, |key, value| {
                next.version = next
                    .version
                    .checked_add(1)
                    .ok_or(Error::SequenceExhausted)?;
                root = tree.apply(next.version, [(key, Some(value))])?;
                Ok(())
            })?;
            self.connection.execute(
                "DELETE FROM chopin_storage_nodes WHERE epoch<>?1",
                [next.epoch],
            )?;
            self.connection.execute(
                "DELETE FROM chopin_storage_values WHERE epoch<>?1",
                [next.epoch],
            )?;
            Some(root)
        } else {
            let changeset = self.session.changeset()?;
            let mut iterator = changeset.iter()?;
            let mut changes = BTreeMap::new();
            use rusqlite::fallible_streaming_iterator::FallibleStreamingIterator;
            while let Some(item) = iterator.next()? {
                let operation = item.op()?;
                let table = schema
                    .tables
                    .get(operation.table_name())
                    .ok_or(Error::UnsupportedSchema)?;
                let inserted = operation.code() == rusqlite::hooks::Action::SQLITE_INSERT;
                let values = table
                    .primary
                    .iter()
                    .map(|&index| {
                        let value = if inserted {
                            item.new_value(index)
                        } else {
                            item.old_value(index)
                        }?;
                        Value::try_from(value).map_err(|_| Error::Integrity)
                    })
                    .collect::<Result<Vec<_>>>()?;
                let mut position = 0;
                let key = table.key(|_| {
                    let value = ValueRef::from(&values[position]);
                    position += 1;
                    Ok(value)
                })?;
                changes.insert(key, table.current(self.connection, &values)?);
            }
            if changes.is_empty() {
                None
            } else {
                next.version = next
                    .version
                    .checked_add(1)
                    .ok_or(Error::SequenceExhausted)?;
                Some(
                    Tree {
                        connection: self.connection,
                        epoch: next.epoch,
                    }
                    .apply(next.version, changes)?,
                )
            }
        };
        if let Some(root) = root {
            let sequence = self
                .previous
                .head
                .sequence
                .checked_add(1)
                .ok_or(Error::SequenceExhausted)?;
            as_integer(sequence)?;
            next.schema = schema.digest;
            next.head = head(next.identity, sequence, schema.digest, root.0);
            save(self.connection, &next)?;
        }
        let prepared = Prepared {
            previous: self.previous.head,
            next: next.head,
        };
        self.prepared = Some(prepared);
        Ok(prepared)
    }

    /// Commits a prepared transaction locally; the caller must still confirm with the host.
    ///
    /// A failed commit poisons this connection because its durable outcome can be
    /// uncertain. Reopening verifies actual content before external reconciliation.
    pub fn commit(mut self) -> Result<Head> {
        let prepared = self.prepared.ok_or(Error::RecoveryRequired)?;
        if let Err(error) = self.connection.execute_batch("COMMIT") {
            self.poisoned.set(true);
            return Err(error.into());
        }
        self.active = false;
        if let Some(schema) = self.updated.take() {
            *self.schema = schema;
        }
        Ok(prepared.next)
    }

    /// Rolls back explicitly, reporting failure rather than implying a guaranteed rollback.
    pub fn rollback(mut self) -> Result<()> {
        match self.connection.execute_batch("ROLLBACK") {
            Ok(()) => {
                self.active = false;
                Ok(())
            }
            Err(error) => {
                self.poisoned.set(true);
                Err(error.into())
            }
        }
    }

    fn writable(&self) -> Result<()> {
        if self.active && self.prepared.is_none() && !self.failed && !self.poisoned.get() {
            Ok(())
        } else {
            Err(Error::RecoveryRequired)
        }
    }
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if self.active && self.connection.execute_batch("ROLLBACK").is_err() {
            self.poisoned.set(true);
        }
    }
}
