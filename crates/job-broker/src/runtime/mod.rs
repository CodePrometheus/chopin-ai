//! Local process control. Kernel observations are distinct from lease and request acknowledgements.

mod capture;
#[cfg(feature = "transport")]
mod controller;
mod filter;
mod gate;
mod journal;
mod namespace;
mod process;
mod status;
#[cfg(feature = "transport")]
mod transport;

pub use capture::{CaptureOptions, OutputFrame, OutputReader, run_capture};
#[cfg(feature = "transport")]
pub use controller::{LocalWorker, WorkerPolicy, WorkerRecovery, WorkerRecoveryPage};
pub use gate::{GateCommand, GateRecord, run_gate};
pub use journal::{LaunchStage, WorkerJournal, WorkerRecord};
pub use namespace::{Namespace, NamespaceConfig, read_records};
pub use process::{HostIdentity, NamespaceProcess, ProcessObservation};
pub use status::read_exit;
