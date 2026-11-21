//! Authenticated client transport and state replication for the agent service.
//!
//! A transport failure leaves remote outcomes unknown. Reconnect and query the
//! original application request; this library never retries a method call.

mod client;
mod conversation;
mod delta;
mod error;
mod goals;
mod learning;
mod legacy_vault;
mod observation;
#[cfg(feature = "schema")]
mod schema;
mod wire;

pub use client::{ChordClient, ConnectionOptions};
pub use conversation::{
    ConversationMode, ConversationRecord, ConversationState, ConversationSummary, ConversationView,
    ModelChoice, ModelChoices, ModelReference, TranscriptEntry, TranscriptPage,
};
pub use error::{CommandRejection, ProtocolError, TransportError};
pub use goals::{
    ArtifactContentPage, EngineCommand, EngineReceipt, EngineWake, GoalArtifact, GoalCommand,
    GoalContinuation, GoalEvidence, GoalGrant, GoalPage, GoalResult, GoalSnapshot, GoalStatus,
    GoalWaiting, PublishedArtifact,
};
pub use learning::{
    CorrectionKind, HeldChange, LoopChange, LoopSettings, LoopSettingsPatch, LoopStanding,
};
pub use legacy_vault::{
    KEY_VERIFICATION_PURPOSE, KeyVerificationBindings, KeyVerificationCapability,
    KeyVerificationRequest, KeyVerificationResponse, SealedKeyVerification,
};
pub use observation::{StateObserver, StateUpdate};
pub use tokio_tungstenite::Connector as TlsConnector;

/// A fallible transport or replication operation.
pub type Result<T> = std::result::Result<T, ProtocolError>;
