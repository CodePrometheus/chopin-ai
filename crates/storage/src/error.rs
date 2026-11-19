use thiserror::Error;

/// A storage failure; no variant contains key material or bound SQL parameters.
#[derive(Debug, Error)]
pub enum Error {
    /// A filesystem operation failed.
    #[error("storage filesystem operation failed: {0}")]
    Io(#[from] std::io::Error),
    /// A different connection owns this storage path.
    #[error("the execution store already has a writer")]
    WriterBusy,
    /// The linked database engine lacks encryption support.
    #[error("the execution store requires an encryption-capable database engine")]
    CipherUnavailable,
    /// A database operation failed.
    #[error("execution database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
    /// Authenticated database contents disagree with their stored head.
    #[error("execution storage integrity verification failed")]
    Integrity,
    /// The schema cannot be captured completely by transactional change tracking.
    #[error("execution storage requires ordinary tables with non-null primary keys")]
    UnsupportedSchema,
    /// A transaction is poisoned, prepared already, or no longer open.
    #[error("the execution store requires recovery before further changes")]
    RecoveryRequired,
    /// A query outside a transaction would modify storage.
    #[error("storage writes require an explicit transaction")]
    TransactionRequired,
    /// The persistent sequence no longer fits the database's integer representation.
    #[error("the execution storage sequence is exhausted")]
    SequenceExhausted,
    /// Persistent authenticated-index data could not be decoded.
    #[error("execution content index is invalid: {0}")]
    Index(#[source] anyhow::Error),
    /// The operating system could not supply fresh randomness.
    #[error("execution storage randomness is unavailable")]
    Randomness,
}

/// Result returned by encrypted storage operations.
pub type Result<T> = std::result::Result<T, Error>;
