use serde_json::Value;

/// A declared command refusal, distinct from unavailable dependencies or uncertain delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandRejection {
    /// The command violates the application contract.
    InvalidCommand,
    /// Current owner or execution authority is absent.
    Forbidden,
    /// The request identity already names different content.
    RequestConflict,
    /// The observed goal revision or continuation source changed.
    GoalConflict,
    /// A terminal goal cannot be overwritten.
    GoalTerminal,
    /// Stop intent bars new input.
    GoalStopping,
    /// The answer does not identify the original question.
    QuestionConflict,
    /// The requested goal is explicitly absent.
    UnknownGoal,
}
impl CommandRejection {
    /// Stable public application code; no remote diagnostic text is exposed.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidCommand => "invalid_command",
            Self::Forbidden => "forbidden",
            Self::RequestConflict => "request_conflict",
            Self::GoalConflict => "goal_conflict",
            Self::GoalTerminal => "goal_terminal",
            Self::GoalStopping => "goal_stopping",
            Self::QuestionConflict => "question_conflict",
            Self::UnknownGoal => "unknown_goal",
        }
    }
}

/// Transport failure details that do not retain credentials or response bodies.
#[derive(Clone, Debug, thiserror::Error)]
#[error("connection failed")]
pub struct TransportError {
    pub(crate) status: Option<u16>,
}

/// A local protocol failure or a complete remote refusal.
#[derive(thiserror::Error)]
#[non_exhaustive]
pub enum ProtocolError {
    /// A local request cannot be represented by the declared application contract.
    #[error("request violates the application contract")]
    InvalidArguments,
    /// The peer or caller closed the connection.
    #[error("connection is closed")]
    Closed,
    /// The transport failed; an outstanding method may already have taken effect.
    #[error(transparent)]
    Transport(TransportError),
    /// A previous operation was cancelled before its wire state was settled.
    #[error("connection must be reopened after an interrupted operation")]
    Interrupted,
    /// A malformed message or unsupported protocol version cannot be consumed.
    #[error("peer violated the wire contract")]
    InvalidFrame,
    /// A state operation cannot be applied exactly; acquire a fresh observation.
    #[error("state cannot be reconstructed; acquire a fresh observation")]
    InvalidState,
    /// A method or contract is absent from the producer's checked-in description.
    #[error("unknown protocol contract or member")]
    UnknownMember,
    /// A configured transport bound was exceeded.
    #[error("message exceeds the configured transport bound")]
    MessageTooLarge,
    /// A wire value could not be represented by the expected schema.
    #[error("invalid JSON value")]
    Json(#[from] serde_json::Error),
    /// The peer returned a complete error for this method; this is not a goal result.
    #[error("remote method was refused")]
    Method {
        /// The declared method that was invoked, without its arguments.
        member: String,
        /// The remote error object. Treat its message as private application data.
        error: Value,
    },
}

impl ProtocolError {
    /// Recognize only complete, declared refusals of command execution; every other outcome remains uncertain.
    pub fn command_rejection(&self) -> Option<CommandRejection> {
        let Self::Method { member, error } = self else {
            return None;
        };
        if member != "execute" || error["kind"] != "plugin" {
            return None;
        }
        Some(match error["code"].as_str()? {
            "invalid_command" => CommandRejection::InvalidCommand,
            "forbidden" => CommandRejection::Forbidden,
            "request_conflict" => CommandRejection::RequestConflict,
            "goal_conflict" => CommandRejection::GoalConflict,
            "goal_terminal" => CommandRejection::GoalTerminal,
            "goal_stopping" => CommandRejection::GoalStopping,
            "question_conflict" => CommandRejection::QuestionConflict,
            "unknown_goal" => CommandRejection::UnknownGoal,
            _ => return None,
        })
    }
    /// HTTP handshake status, when the failure was an HTTP response.
    pub fn http_status(&self) -> Option<u16> {
        match self {
            Self::Transport(error) => error.status,
            _ => None,
        }
    }
}

impl std::fmt::Debug for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProtocolError")
            .field("message", &self.to_string())
            .field("http_status", &self.http_status())
            .finish_non_exhaustive()
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for ProtocolError {
    fn from(error: tokio_tungstenite::tungstenite::Error) -> Self {
        use tokio_tungstenite::tungstenite::Error;
        match error {
            Error::ConnectionClosed | Error::AlreadyClosed => Self::Closed,
            Error::Capacity(_) => Self::MessageTooLarge,
            Error::Http(response) => Self::Transport(TransportError {
                status: Some(response.status().as_u16()),
            }),
            _ => Self::Transport(TransportError { status: None }),
        }
    }
}
