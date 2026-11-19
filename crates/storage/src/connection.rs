use crate::{
    Database, Error, Options, Result, Rows,
    schema::{PREFIX, Schema},
};
use rusqlite::{
    Connection, OpenFlags,
    hooks::{AuthAction, AuthContext, Authorization},
    types::Value,
};
use std::{
    cell::Cell,
    fs::{File, OpenOptions},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use zeroize::Zeroizing;

impl Database {
    pub(super) fn from_connection(
        mut connection: Connection,
        schema: Schema,
        writer: File,
    ) -> Result<Self> {
        let privileged = Arc::new(AtomicBool::new(true));
        let scope = privileged.clone();
        connection.authorizer(Some(move |context: AuthContext<'_>| {
            if scope.load(Ordering::Relaxed) {
                return Authorization::Allow;
            }
            match context.action {
                // Change capture and structural migrations perform these read-only checks internally.
                AuthAction::Pragma { pragma_name, .. }
                    if pragma_name.eq_ignore_ascii_case("table_xinfo")
                        || pragma_name.eq_ignore_ascii_case("quick_check") =>
                {
                    Authorization::Allow
                }
                AuthAction::Transaction { .. }
                | AuthAction::Savepoint { .. }
                | AuthAction::Pragma { .. }
                | AuthAction::Attach { .. }
                | AuthAction::Detach { .. }
                | AuthAction::CreateTempTable { .. }
                | AuthAction::CreateTempIndex { .. }
                | AuthAction::CreateTempTrigger { .. }
                | AuthAction::CreateTempView { .. }
                | AuthAction::CreateVtable { .. }
                | AuthAction::DropVtable { .. }
                | AuthAction::Unknown { .. } => Authorization::Deny,
                AuthAction::Read { table_name, .. }
                | AuthAction::Insert { table_name }
                | AuthAction::Update { table_name, .. }
                | AuthAction::Delete { table_name }
                | AuthAction::CreateTable { table_name }
                | AuthAction::DropTable { table_name }
                | AuthAction::CreateIndex { table_name, .. }
                | AuthAction::DropIndex { table_name, .. }
                | AuthAction::CreateTrigger { table_name, .. }
                | AuthAction::DropTrigger { table_name, .. }
                | AuthAction::AlterTable { table_name, .. }
                    if table_name.starts_with(PREFIX) =>
                {
                    Authorization::Deny
                }
                AuthAction::Function { function_name }
                    if function_name.eq_ignore_ascii_case("load_extension") =>
                {
                    Authorization::Deny
                }
                _ => Authorization::Allow,
            }
        }))?;
        Ok(Self {
            connection,
            schema,
            privileged,
            poisoned: Cell::new(false),
            _writer: writer,
        })
    }
}

pub(super) struct Scope<'a>(&'a AtomicBool);
impl<'a> Scope<'a> {
    pub(super) fn new(privileged: &'a AtomicBool) -> Self {
        privileged.store(false, Ordering::Relaxed);
        Self(privileged)
    }
}
impl Drop for Scope<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub(super) fn writer_lock(path: &Path) -> Result<File> {
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(name)?;
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => Error::WriterBusy,
        std::fs::TryLockError::Error(error) => Error::Io(error),
    })?;
    Ok(file)
}

pub(super) fn connect(path: &Path, key: &[u8; 32], options: &Options) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE,
    )?;
    let mut raw = Zeroizing::new(String::from("x'"));
    use std::fmt::Write;
    for byte in key {
        write!(&mut *raw, "{byte:02x}").map_err(|_| Error::Integrity)?;
    }
    raw.push('\'');
    connection
        .pragma_update(None, "key", &*raw)
        .map_err(|_| Error::Integrity)?;
    let cipher: Option<String> = connection
        .query_row("PRAGMA cipher_version", [], |row| row.get(0))
        .optional()?;
    if cipher.is_none_or(|version| version.is_empty()) {
        return Err(Error::CipherUnavailable);
    }
    connection.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA cipher_memory_security=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF")?;
    if let Some(budget) = options.cache_kib {
        connection.pragma_update(None, "cache_size", -i64::from(budget.get()))?;
    }
    if let Some(timeout) = options.busy_timeout {
        connection.busy_timeout(timeout)?;
    }
    let mut check = connection.prepare("PRAGMA cipher_integrity_check")?;
    if check.query([])?.next()?.is_some() {
        return Err(Error::Integrity);
    }
    drop(check);
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(Error::Integrity);
    }
    Ok(connection)
}

use rusqlite::OptionalExtension;

pub(super) fn query(connection: &Connection, sql: &str, values: &[Value]) -> Result<Rows> {
    let mut statement = connection.prepare_cached(sql)?;
    if !statement.readonly() {
        return Err(Error::TransactionRequired);
    }
    let columns = statement
        .column_names()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut rows = statement.query(rusqlite::params_from_iter(values))?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(
            (0..columns.len())
                .map(|index| row.get(index))
                .collect::<rusqlite::Result<Vec<Value>>>()?,
        );
    }
    Ok(Rows {
        columns,
        values: result,
    })
}
