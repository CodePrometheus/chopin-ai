/// A command refusal, an uncertain dependency, or a failed transaction.
#[derive(thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// The credential cannot authenticate this caller purpose.
    #[error("command authentication required")]
    Unauthorized,
    /// The current caller lacks the required authority.
    #[error("command permission denied")]
    Forbidden,
    /// No original operation exists in this caller's scope.
    #[error("command not found")]
    NotFound,
    /// An identity was reused with different immutable data or an incompatible event.
    #[error("command identity conflicts with recorded data")]
    Conflict,
    /// The request cannot be represented by the command contract.
    #[error("invalid command request")]
    Invalid,
    /// The transactional store does not provide the required commit durability.
    #[error("durable command storage required")]
    Durability,
    /// The original remote outcome is unknown; observe it before taking another action.
    #[error("command dependency is unavailable")]
    Unavailable {
        /// The host's explicit retry policy, in milliseconds.
        retry_after_ms: u64,
    },
    /// Encrypted data failed authentication or belongs to another record.
    #[error("command record authentication failed")]
    Ciphertext,
    /// A cryptographic nonce could not be obtained.
    #[error("command randomness unavailable")]
    Randomness,
    /// A database operation failed; a commit's outcome may be unknown.
    #[error("command transaction failed")]
    Database(#[from] sqlx::Error),
    /// Local worker I/O failed; no missing observation is synthesized.
    #[error("worker I/O failed")]
    Io(#[from] std::io::Error),
    /// A record could not be decoded; its contents are not exposed in the error.
    #[error("invalid command record")]
    Json(#[from] serde_json::Error),
}

impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandError")
            .field("message", &self.to_string())
            .finish_non_exhaustive()
    }
}

/// A fallible admission, storage or worker operation.
pub type Result<T> = std::result::Result<T, Error>;
