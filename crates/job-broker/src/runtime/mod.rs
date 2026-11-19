//! Local process control. Kernel observations are distinct from lease and request acknowledgements.

mod capture;
#[cfg(feature = "transport")]
mod controller;
mod filter;
mod gate;
mod journal;
mod namespace;
mod process;
#[cfg(feature = "transport")]
mod service;
mod status;
#[cfg(feature = "transport")]
mod transport;

pub use capture::{CaptureOptions, OutputFrame, OutputReader, run_capture};
#[cfg(feature = "transport")]
pub use controller::{LocalWorker, WorkerPolicy, WorkerRecovery, WorkerRecoveryPage};
pub use gate::{GateCommand, GateRecord, run_gate};
pub use journal::{LaunchStage, WorkerJournal, WorkerRecord};
pub use namespace::{Namespace, NamespaceConfig, NetworkMode, read_records};
pub use process::{HostIdentity, NamespaceProcess, ProcessObservation};
#[cfg(feature = "transport")]
pub use service::{WorkerServicePolicy, serve_worker};
pub use status::read_exit;
