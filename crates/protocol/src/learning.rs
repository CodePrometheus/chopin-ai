use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{ChordClient, ProtocolError, Result};

/// Source improvement summary; spending and acceptance remain execution-owned.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopStanding {
    /// Source layer version.
    pub version: u64,
    /// Adopted changes.
    pub in_use: u64,
    /// Archived changes.
    pub archived: u64,
    /// Known failure kinds.
    pub kinds: u64,
    /// Recurring kinds.
    pub recurring: u64,
    /// Shelved kinds.
    pub shelved: u64,
    /// Corrections awaiting policy.
    pub corrections: u64,
    /// Held candidates.
    pub held: u64,
    /// Actual source spending in USD.
    pub spent_usd: f64,
    /// Configured weekly budget, absent when none is set.
    pub weekly_budget_usd: Option<f64>,
}
/// An actual evaluated change in the source layer.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopChange {
    /// Immutable source identity.
    pub id: String,
    /// Original timestamp representation.
    pub added: String,
    /// Extensible change kind.
    pub kind: String,
    /// Whether this change is archived.
    pub archived: bool,
    /// Evaluated change text.
    pub text: String,
}
/// A recurring correction requiring the owner's policy.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CorrectionKind {
    /// Source policy key.
    pub key: String,
    /// Number of observed sessions.
    pub sessions: u64,
    /// Actual examples provided by the service.
    pub examples: Vec<String>,
}
/// A candidate waiting for permission to evaluate, not an adopted change.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeldChange {
    /// Source candidate identity.
    pub id: String,
    /// Actual failure motivating the proposal.
    pub failure: String,
    /// Extensible change kind.
    pub kind: String,
    /// Target skill, when provided.
    pub skill: Option<String>,
    /// Proposed change.
    pub text: String,
    /// Source prediction to test.
    pub prediction: String,
    /// Audit reasons for holding this candidate.
    pub reasons: Vec<String>,
}
/// Actual improvement policy read from the service.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSettings {
    /// Configured weekly budget in USD.
    pub weekly_budget_usd: Option<f64>,
    /// Configured regular model reference.
    pub regular_model: Option<String>,
    /// Configured strong model reference.
    pub strong_model: Option<String>,
    /// Whether candidates wait for an explicit owner decision.
    pub hold_for_review: bool,
}
/// Explicit policy edit: outer `None` preserves a field, inner `None` clears it.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSettingsPatch {
    /// Preserve, clear or replace the weekly budget.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekly_budget_usd: Option<Option<f64>>,
    /// Preserve, clear or replace the regular model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regular_model: Option<Option<String>>,
    /// Preserve, clear or replace the strong model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strong_model: Option<Option<String>>,
    /// Change owner review policy when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hold_for_review: Option<bool>,
}
impl ChordClient {
    /// Read the execution-owned improvement summary.
    pub async fn loop_standing(&mut self) -> Result<LoopStanding> {
        Ok(serde_json::from_value(
            self.invoke("chopin.loop", json!({}), "standing", None)
                .await?,
        )?)
    }
    /// Read actual evaluated changes.
    pub async fn loop_changes(&mut self) -> Result<Vec<LoopChange>> {
        Ok(serde_json::from_value(
            self.invoke("chopin.loop", json!({}), "changes", None)
                .await?,
        )?)
    }
    /// Read recurring corrections.
    pub async fn loop_corrections(&mut self) -> Result<Vec<CorrectionKind>> {
        Ok(serde_json::from_value(
            self.invoke("chopin.loop", json!({}), "corrections", None)
                .await?,
        )?)
    }
    /// Read held candidates without granting evaluation authority.
    pub async fn loop_held(&mut self) -> Result<Vec<HeldChange>> {
        Ok(serde_json::from_value(
            self.invoke("chopin.loop", json!({}), "held", None).await?,
        )?)
    }
    /// Read current policy.
    pub async fn loop_settings(&mut self) -> Result<LoopSettings> {
        Ok(serde_json::from_value(
            self.invoke("chopin.loop", json!({}), "settings", None)
                .await?,
        )?)
    }
    /// Apply one explicit edit; a transport failure is not retried automatically.
    pub async fn set_loop_settings(&mut self, patch: &LoopSettingsPatch) -> Result<LoopSettings> {
        if patch
            .weekly_budget_usd
            .flatten()
            .is_some_and(|value| !value.is_finite() || value < 0.0)
            || [&patch.regular_model, &patch.strong_model]
                .iter()
                .any(|value| {
                    value
                        .as_ref()
                        .and_then(Option::as_ref)
                        .is_some_and(String::is_empty)
                })
        {
            return Err(ProtocolError::InvalidArguments);
        }
        Ok(serde_json::from_value(
            self.invoke(
                "chopin.loop",
                json!({}),
                "setSettings",
                Some(serde_json::to_value(patch)?),
            )
            .await?,
        )?)
    }
    /// Permit evaluation or reject an original held candidate; approval never claims adoption.
    pub async fn decide_loop_change(&mut self, id: &str, approve: bool) -> Result<()> {
        self.invoke(
            "chopin.loop",
            json!({}),
            "decide",
            Some(json!({"id":id,"approve":approve})),
        )
        .await?;
        Ok(())
    }
    /// Archive an original evaluated change.
    pub async fn undo_loop_change(&mut self, id: &str) -> Result<()> {
        self.invoke("chopin.loop", json!({}), "undo", Some(json!({"id":id})))
            .await?;
        Ok(())
    }
    /// Apply owner policy to the original correction kind.
    pub async fn answer_loop_correction(&mut self, key: &str, learn: bool) -> Result<()> {
        self.invoke(
            "chopin.loop",
            json!({}),
            "answer",
            Some(json!({"key":key,"learn":learn})),
        )
        .await?;
        Ok(())
    }
}
