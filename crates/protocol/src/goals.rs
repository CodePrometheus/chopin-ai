use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{ChordClient, ProtocolError, Result, StateObserver};

/// Exact host delegation adopted by an execution goal.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalGrant {
    /// Stable delegation identity.
    pub id: String,
    /// Exact adopted revision.
    pub version: u64,
}
/// Original terminal goal whose context an explicit new goal continues.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalContinuation {
    /// Source goal identity.
    pub goal_id: String,
    /// Source revision chosen by the owner.
    pub expected_version: u64,
}
/// Owner commands retain their original request identity across uncertain delivery.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum GoalCommand {
    /// Admit a new goal without changing an existing goal's original objective.
    #[serde(rename = "goal.submit")]
    Submit {
        /// Original owner objective.
        objective: String,
        /// Explicit conditions; empty while they are still being established.
        completion_criteria: Vec<String>,
        /// Adopted execution delegation.
        grant: GoalGrant,
        /// Optional terminal context for explicitly requested new work.
        #[serde(skip_serializing_if = "Option::is_none")]
        continuation: Option<GoalContinuation>,
    },
    /// Add input to the original goal and, explicitly, replace its delegation.
    #[serde(rename = "goal.input")]
    Input {
        /// Original goal.
        goal_id: String,
        /// Goal revision the owner observed.
        expected_version: u64,
        /// Original input text.
        text: String,
        /// Original persisted question, if this answers a question.
        #[serde(skip_serializing_if = "Option::is_none")]
        question_id: Option<String>,
        /// Explicit replacement, absent for ordinary owner input.
        #[serde(skip_serializing_if = "Option::is_none")]
        grant: Option<GoalGrant>,
    },
    /// Persist stop intent; its receipt does not establish termination.
    #[serde(rename = "goal.stop")]
    Stop {
        /// Original goal.
        goal_id: String,
        /// Goal revision the owner observed.
        expected_version: u64,
    },
}
impl GoalCommand {
    /// Construct a new immutable objective without inventing a client-side goal result.
    pub fn submit(objective: String, completion_criteria: Vec<String>, grant: GoalGrant) -> Self {
        Self::Submit {
            objective,
            completion_criteria,
            grant,
            continuation: None,
        }
    }
    /// Continue terminal context under a new request and goal identity.
    pub fn continue_goal(
        objective: String,
        completion_criteria: Vec<String>,
        grant: GoalGrant,
        continuation: GoalContinuation,
    ) -> Self {
        Self::Submit {
            objective,
            completion_criteria,
            grant,
            continuation: Some(continuation),
        }
    }
    /// Validate the producer's representation. This never grants execution authority.
    pub fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::Submit {
                objective,
                completion_criteria,
                grant,
                continuation,
            } => {
                !objective.trim().is_empty()
                    && completion_criteria
                        .iter()
                        .all(|value| !value.trim().is_empty())
                    && valid_grant(grant)
                    && continuation.as_ref().is_none_or(|source| {
                        !source.goal_id.is_empty() && revision(source.expected_version)
                    })
            }
            Self::Input {
                goal_id,
                expected_version,
                text,
                question_id,
                grant,
            } => {
                !goal_id.is_empty()
                    && revision(*expected_version)
                    && !text.trim().is_empty()
                    && question_id.as_ref().is_none_or(|id| !id.is_empty())
                    && grant.as_ref().is_none_or(valid_grant)
            }
            Self::Stop {
                goal_id,
                expected_version,
            } => !goal_id.is_empty() && revision(*expected_version),
        };
        if !valid {
            return Err(ProtocolError::InvalidArguments);
        }
        Ok(())
    }
}
/// One stable command envelope, retained by the caller before sending.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineCommand {
    /// Supported application representation version.
    pub version: u32,
    /// Stable request identity, scoped by the owner execution store.
    pub request_id: String,
    /// Exact original command.
    pub command: GoalCommand,
}
impl EngineCommand {
    /// Bind the caller's already persisted identity to its original command.
    pub fn new(request_id: String, command: GoalCommand) -> Self {
        Self {
            version: 1,
            request_id,
            command,
        }
    }
}
/// Durable admission only; completion remains in the goal's authoritative snapshot.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineReceipt {
    /// Supported receipt version.
    pub version: u32,
    /// Original request identity.
    pub request_id: String,
    /// Original accepted goal identity.
    pub goal_id: String,
    /// Goal revision committed with admission.
    pub accepted_version: u64,
}
/// Execution-owned goal status; transport receipts do not determine it.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    /// Accepted before advancing.
    Accepted,
    /// Execution or its required work is being coordinated.
    Running,
    /// A persisted question requires input.
    WaitingUser,
    /// Current delegated authority is required.
    WaitingAuthorization,
    /// A persisted deadline has not arrived.
    WaitingTime,
    /// A required source or verification is unavailable.
    WaitingDependency,
    /// Stop intent is stored but effects may still be active.
    Stopping,
    /// Source evidence and required work were verified.
    Completed,
    /// The engine confirmed the stopping boundary.
    Stopped,
    /// The engine recorded an unrecoverable failure.
    Failed,
}
/// Persisted waiting condition belonging to the original goal.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalWaiting {
    /// Actual waiting reason.
    pub reason: String,
    /// Original question identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    /// Absolute source deadline in Unix milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<f64>,
}
/// A verified workspace artifact, not an unauthenticated download URL.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalArtifact {
    /// Original resource-relative path, interpreted by the host's artifact service.
    pub path: String,
    /// Verified content digest.
    pub sha256: String,
}
/// Source evidence associated with an explicit completion criterion.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum GoalEvidence {
    /// A delivered assistant entry, assessed by the trusted verifier.
    Assistant {
        /// Zero-based criterion index.
        criterion: u64,
        /// Actual committed source entry.
        entry_id: u64,
    },
    /// A successful completed tool action.
    Tool {
        /// Zero-based criterion index.
        criterion: u64,
        /// Actual committed source result.
        entry_id: u64,
        /// Optional artifact checked under the goal's resource authority.
        #[serde(skip_serializing_if = "Option::is_none")]
        artifact: Option<GoalArtifact>,
    },
}
impl GoalEvidence {
    /// Original criterion index.
    pub fn criterion(&self) -> u64 {
        match self {
            Self::Assistant { criterion, .. } | Self::Tool { criterion, .. } => *criterion,
        }
    }
    /// Original immutable entry identity.
    pub fn entry_id(&self) -> u64 {
        match self {
            Self::Assistant { entry_id, .. } | Self::Tool { entry_id, .. } => *entry_id,
        }
    }
    /// Source-verified artifact when one was supplied.
    pub fn artifact(&self) -> Option<&GoalArtifact> {
        match self {
            Self::Tool { artifact, .. } => artifact.as_ref(),
            _ => None,
        }
    }
}
/// Verified result, absent before the engine commits completion.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalResult {
    /// Actual result summary.
    pub summary: String,
    /// Source references covering explicit criteria.
    pub evidence: Vec<GoalEvidence>,
    /// Source verification time in Unix milliseconds.
    pub verified_at: f64,
}
/// Original goal state from execution, never a platform projection of another state machine.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSnapshot {
    /// Stable execution-local identity.
    pub goal_id: String,
    /// Original work conversation.
    pub conversation_id: u64,
    /// Monotonic source revision.
    pub version: u64,
    /// Original objective.
    pub objective: String,
    /// Explicit accepted conditions.
    pub completion_criteria: Vec<String>,
    /// Actual execution status.
    pub status: GoalStatus,
    /// Exact adopted delegation.
    pub grant: GoalGrant,
    /// Source creation time in Unix milliseconds.
    pub created_at: f64,
    /// Source update time in Unix milliseconds.
    pub updated_at: f64,
    /// Persisted waiting condition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting: Option<GoalWaiting>,
    /// Verified final result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<GoalResult>,
}
/// One authoritative source page.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GoalPage {
    /// Goals from this page alone.
    pub goals: Vec<GoalSnapshot>,
    /// Source-owned continuation, preserved unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Value>,
}
/// Actual source scheduling needs, separate from client connectivity.
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EngineWake {
    /// Work needs an active execution process now.
    pub active: bool,
    /// Earliest persisted future wake, in Unix milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<f64>,
}
impl ChordClient {
    /// Submit the original envelope once. A transport failure leaves admission unknown.
    pub async fn execute(&mut self, envelope: &EngineCommand) -> Result<EngineReceipt> {
        if envelope.version != 1 || envelope.request_id.is_empty() {
            return Err(ProtocolError::InvalidArguments);
        }
        envelope.command.validate()?;
        let receipt: EngineReceipt = serde_json::from_value(
            self.invoke(
                "chopin.goals",
                json!({}),
                "execute",
                Some(serde_json::to_value(envelope)?),
            )
            .await?,
        )?;
        if receipt.version != 1
            || receipt.request_id != envelope.request_id
            || receipt.goal_id.is_empty()
            || !revision(receipt.accepted_version)
        {
            return Err(ProtocolError::InvalidState);
        }
        Ok(receipt)
    }
    /// Reconcile one original request without re-executing it.
    pub async fn request(&mut self, request_id: &str) -> Result<Option<EngineReceipt>> {
        if request_id.is_empty() {
            return Err(ProtocolError::InvalidArguments);
        }
        let receipt: Option<EngineReceipt> = serde_json::from_value(
            self.invoke(
                "chopin.goals",
                json!({}),
                "request",
                Some(json!({"requestId":request_id})),
            )
            .await?,
        )?;
        if receipt.as_ref().is_some_and(|receipt| {
            receipt.version != 1
                || receipt.request_id != request_id
                || !revision(receipt.accepted_version)
                || receipt.goal_id.is_empty()
        }) {
            return Err(ProtocolError::InvalidState);
        }
        Ok(receipt)
    }
    /// Read a goal snapshot without retaining its subscription.
    pub async fn snapshot(&mut self, goal: &str) -> Result<GoalSnapshot> {
        if goal.is_empty() {
            return Err(ProtocolError::InvalidArguments);
        }
        let state = self
            .state_snapshot("chopin.goal", json!({"goal":goal}))
            .await?;
        let snapshot: GoalSnapshot = serde_json::from_value(
            state
                .get("snapshot")
                .ok_or(ProtocolError::InvalidState)?
                .clone(),
        )?;
        if snapshot.goal_id != goal {
            return Err(ProtocolError::InvalidState);
        }
        Ok(snapshot)
    }
    /// Acquire a dedicated goal observation; closing it never cancels execution.
    pub async fn observe_goal(self, goal: &str) -> Result<StateObserver> {
        if goal.is_empty() {
            return Err(ProtocolError::InvalidArguments);
        }
        self.observe("chopin.goal", json!({"goal":goal})).await
    }
    /// Read one source goal page.
    pub async fn goals(&mut self, limit: u64, cursor: Option<Value>) -> Result<GoalPage> {
        if !revision(limit) {
            return Err(ProtocolError::InvalidArguments);
        }
        let mut args = json!({"limit":limit});
        if let Some(cursor) = cursor {
            args["cursor"] = cursor;
        }
        Ok(serde_json::from_value(
            self.invoke("chopin.goals", json!({}), "page", Some(args))
                .await?,
        )?)
    }
    /// Read the exact execution-owned conversation binding.
    pub async fn goal_for_conversation(
        &mut self,
        conversation: u64,
    ) -> Result<Option<GoalSnapshot>> {
        if !revision(conversation) {
            return Err(ProtocolError::InvalidArguments);
        }
        let goal: Option<GoalSnapshot> = serde_json::from_value(
            self.invoke(
                "chopin.goals",
                json!({}),
                "forConversation",
                Some(json!({"conversation":conversation})),
            )
            .await?,
        )?;
        if goal
            .as_ref()
            .is_some_and(|goal| goal.conversation_id != conversation)
        {
            return Err(ProtocolError::InvalidState);
        }
        Ok(goal)
    }
    /// Read execution scheduling needs; failures never synthesize idle.
    pub async fn wake(&mut self) -> Result<EngineWake> {
        Ok(serde_json::from_value(
            self.invoke("chopin.goals", json!({}), "wake", None).await?,
        )?)
    }
    /// Enable the original scheduler without creating another goal.
    pub async fn resume(&mut self) -> Result<()> {
        self.invoke("chopin.goals", json!({}), "resume", None)
            .await?;
        Ok(())
    }
}
fn revision(value: u64) -> bool {
    value > 0 && value <= crate::wire::MAX_SAFE_INTEGER
}
fn valid_grant(grant: &GoalGrant) -> bool {
    !grant.id.is_empty() && revision(grant.version)
}
