//! Durable command records keep external outcomes separate from transport receipts.
//!
//! The host supplies identity, current authorization and actual worker placement.
//! A replacement runtime reconciles the original operation and worker; it never
//! takes an expired lease as evidence that a process has stopped.

mod broker;
mod coordination;
mod error;
#[cfg(feature = "transport")]
mod http;
mod ledger;
#[cfg(all(feature = "worker", target_os = "linux"))]
pub mod runtime;
mod settings;
mod storage;
#[cfg(feature = "transport")]
mod transport;
mod types;
mod worker;

pub use broker::{Broker, RecoveryPage, RecoveryResult};
pub use coordination::{BrokerStore, BrokerTransaction};
pub use error::{Error, Result};
#[cfg(feature = "transport")]
pub use http::{ControlClient, HttpWorkerTransport, TransportPolicy};
pub use ledger::{
    JobKey, Ledger, OutputPage, PendingPage, Phase, Record, SCHEMA_V1, Snapshot, State,
};
pub use settings::{Admission, Settings};
pub use storage::{
    LedgerStorage, LedgerStore, LedgerTransaction, SQLITE_SCHEMA_V1, SealedRecord, StoreTransaction,
};
pub use types::{
    Action, Caller, Credential, ExitStatus, GrantReference, HostAuthority, JobId, ProcessIdentity,
    Request, Source, Stream, TransactionalHostAuthority, WorkerAction, WorkerCaller, WorkerEvent,
};
pub use worker::{
    Callback, WorkerDirectory, WorkerEndpoint, WorkerLookup, WorkerObservation, WorkerStart,
    WorkerState, WorkerTransport,
};
