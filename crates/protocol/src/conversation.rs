use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{ChordClient, ProtocolError, Result, StateObserver};

/// Conversation tool policy, supplied by the execution service.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationMode {
    /// Only explicitly read-only tools may execute.
    Read,
    /// Tools remain subject to the host's current authority and resource policy.
    Full,
}
/// Current conversation presentation; this bounded window is not its entire history.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationState {
    /// Producer-owned structural view and extensible documents.
    pub view: ConversationView,
    /// Actual tool policy.
    pub mode: ConversationMode,
    /// Owner's display name for the conversation.
    pub name: String,
    /// Actual submission outcomes, keyed by source identity.
    pub submissions: BTreeMap<String, Value>,
    /// Owner command progress, absent when no command is running.
    pub running: Option<Value>,
}
impl std::fmt::Debug for ConversationState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConversationState")
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}
/// Source identity and ownership metadata of one conversation.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConversationRecord {
    /// Stable source identity.
    pub id: u64,
    /// Source ownership and history ancestry, preserved without interpreting unknown fields.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
/// Materialized source window; older entries remain available through history pages.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Serialize, Deserialize)]
pub struct ConversationView {
    /// Original identity and ownership.
    pub conversation: ConversationRecord,
    /// Visible entries in source order.
    pub entries: Vec<TranscriptEntry>,
    /// Entry immediately before this window, when older history exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<u64>,
    /// Extensible source documents, including live progress and usage.
    pub docs: BTreeMap<String, Value>,
}
impl std::fmt::Debug for ConversationView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConversationView")
            .field("conversation", &self.conversation.id)
            .field("entries", &self.entries.len())
            .finish_non_exhaustive()
    }
}
/// Source conversation metadata for navigation, not a goal completion decision.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    /// Source conversation identity.
    pub id: u64,
    /// Owner's title.
    pub name: String,
    /// First user message supplied by the producer.
    pub first: String,
    /// Number of messages in the source summary.
    pub messages: u64,
    /// Creation time in Unix milliseconds.
    pub created: f64,
    /// Latest source modification time in Unix milliseconds.
    pub modified: f64,
    /// Whether an agent run is active.
    pub running: bool,
    /// Whether its latest answer failed.
    pub failed: bool,
    /// Owner's pinned selection.
    pub pinned: bool,
    /// Owner's archive selection.
    pub archived: bool,
    /// Last source state acknowledged as seen, in Unix milliseconds.
    pub seen: f64,
}
/// A durable source entry, retaining unknown application fields.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEntry {
    /// Immutable source entry identity.
    pub id: u64,
    /// Actual origin, which can be an ancestor of a fork.
    pub conversation_id: u64,
    /// Extensible source kind.
    pub kind: String,
    /// Actual model messages contributed by this entry.
    pub model: Option<Vec<Value>>,
    /// Optional application data.
    pub data: Option<Value>,
    /// Source metadata not interpreted by this client.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
impl std::fmt::Debug for TranscriptEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TranscriptEntry")
            .field("id", &self.id)
            .field("conversation_id", &self.conversation_id)
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}
/// One raw history page; the source decides when its cursor ends.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TranscriptPage {
    /// Entries in descending history order.
    pub entries: Vec<TranscriptEntry>,
    /// Opaque source cursor, including on a nonterminal empty page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Value>,
}
/// Provider-qualified model reference from the source catalog.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReference {
    /// Actual configured provider.
    pub provider: String,
    /// Model identity within that provider.
    pub model_id: String,
}
/// One model currently usable by the service's owner.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    /// Actual configured provider.
    pub provider: String,
    /// Model identity within that provider.
    pub model_id: String,
    /// Source display name.
    pub name: String,
    /// Source-declared context window in tokens.
    pub context_window: u64,
    /// Whether images are supported.
    pub images: bool,
    /// Source-supported thinking levels.
    pub thinking_levels: Vec<String>,
}
/// The current catalog and actual default model, read together from the service.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelChoices {
    /// Models whose providers the owner can currently use.
    pub models: Vec<ModelChoice>,
    /// Default for a new conversation, if one is configured.
    pub current: Option<ModelReference>,
}
impl ChordClient {
    /// Read actual conversation navigation metadata without creating a conversation.
    pub async fn summaries(&mut self) -> Result<Vec<ConversationSummary>> {
        Ok(serde_json::from_value(
            self.invoke("chopin.conversations", json!({}), "summaries", None)
                .await?,
        )?)
    }
    /// Read the producer's available models and current default.
    pub async fn models(&mut self) -> Result<ModelChoices> {
        Ok(serde_json::from_value(
            self.invoke("chopin.conversations", json!({}), "models", None)
                .await?,
        )?)
    }
    /// Acquire one conversation snapshot followed by authoritative changes. Disconnecting stops no work.
    pub async fn observe_conversation(self, conversation: u64) -> Result<StateObserver> {
        identifier(conversation)?;
        self.observe("chopin.conversation", json!({"conversation":conversation}))
            .await
    }
    /// Read one original history page. No client-side truncation or automatic collection is applied.
    pub async fn entries(
        &mut self,
        conversation: u64,
        limit: u64,
        cursor: Option<Value>,
        at_or_before: Option<u64>,
    ) -> Result<TranscriptPage> {
        identifier(conversation)?;
        identifier(limit)?;
        if at_or_before.is_some_and(|entry| entry > crate::wire::MAX_SAFE_INTEGER) {
            return Err(ProtocolError::InvalidArguments);
        }
        let mut args = json!({"limit":limit});
        if let Some(cursor) = cursor {
            args["cursor"] = cursor;
        }
        if let Some(entry) = at_or_before {
            args["atOrBefore"] = json!(entry);
        }
        Ok(serde_json::from_value(
            self.invoke(
                "chopin.conversation",
                json!({"conversation":conversation}),
                "entries",
                Some(args),
            )
            .await?,
        )?)
    }
}
fn identifier(value: u64) -> Result<()> {
    if value == 0 || value > crate::wire::MAX_SAFE_INTEGER {
        return Err(ProtocolError::InvalidArguments);
    }
    Ok(())
}
