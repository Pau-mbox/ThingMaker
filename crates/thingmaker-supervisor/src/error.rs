//! Typed desktop errors (spec section 20.1).
//!
//! Every renderer-facing command resolves exactly once with either a result or
//! a [`DesktopError`]. Messages are safe for display: they never carry raw
//! protocol payloads, which may contain secrets. Detailed context is logged
//! under `diagnostic_id` instead.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    NotReady,
    Locked,
    Unsupported,
    Conflict,
    Untrusted,
    Io,
    AuthRequired,
    OutcomeUnknown,
    Protocol,
    LimitExceeded,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryPolicy {
    Never,
    ReadOnly,
    AfterReconcile,
    UserAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code:?}: {message}")]
pub struct DesktopError {
    pub code: ErrorCode,
    /// Safe for user display; never a raw secret-bearing payload.
    pub message: String,
    pub retry: RetryPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_id: Option<String>,
}

impl DesktopError {
    pub fn new(code: ErrorCode, message: impl Into<String>, retry: RetryPolicy) -> Self {
        Self {
            code,
            message: message.into(),
            retry,
            diagnostic_id: None,
        }
    }

    /// Attaches a fresh diagnostic identifier so logs can be correlated
    /// without leaking payload content into the user-facing message.
    pub fn with_diagnostic(mut self) -> Self {
        self.diagnostic_id = Some(uuid::Uuid::new_v4().simple().to_string());
        self
    }

    pub fn not_ready(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotReady, message, RetryPolicy::AfterReconcile)
    }

    pub fn locked(message: impl Into<String>, retry: RetryPolicy) -> Self {
        Self::new(ErrorCode::Locked, message, retry)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, message, RetryPolicy::Never)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message, RetryPolicy::AfterReconcile)
    }

    pub fn untrusted(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Untrusted, message, RetryPolicy::UserAction)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message, RetryPolicy::UserAction)
    }

    pub fn auth_required(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::AuthRequired, message, RetryPolicy::UserAction)
    }

    pub fn outcome_unknown(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::OutcomeUnknown, message, RetryPolicy::AfterReconcile)
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Protocol, message, RetryPolicy::Never)
    }

    pub fn limit_exceeded(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::LimitExceeded, message, RetryPolicy::UserAction)
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Cancelled, message, RetryPolicy::UserAction)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_screaming_code_and_camel_case_keys() {
        let error = DesktopError::locked(
            "session is locked by another process",
            RetryPolicy::UserAction,
        );
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["code"], "LOCKED");
        assert_eq!(json["retry"], "user_action");
        assert!(json.get("diagnosticId").is_none());
        let with_id = error.with_diagnostic();
        let json = serde_json::to_value(&with_id).unwrap();
        assert!(json["diagnosticId"].as_str().unwrap().len() == 32);
    }
}
