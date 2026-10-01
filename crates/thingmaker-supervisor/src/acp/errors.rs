//! Typed desktop errors from ACP transport and JSON-RPC failures, and the one
//! request builder whose value typing the protocol fixes
//! (`session/set_config_option`).

use serde_json::{Value, json};

use crate::{
    error::DesktopError,
    transport::{TransportError, jsonrpc},
};

/// `session/set_config_option` params. Strings are option ids
/// (`type: "id"`), booleans are `type: "boolean"`. An object that already
/// carries a `type` is passed through unchanged so future value kinds stay
/// reachable.
pub fn set_config_option_params(session_id: &str, config_id: &str, value: &Value) -> Result<Value, DesktopError> {
    let mut params = json!({ "sessionId": session_id, "configId": config_id });
    let object = params.as_object_mut().expect("object");
    match value {
        Value::String(id) => {
            object.insert("type".into(), Value::String("id".into()));
            object.insert("value".into(), Value::String(id.clone()));
        }
        Value::Bool(flag) => {
            object.insert("type".into(), Value::String("boolean".into()));
            object.insert("value".into(), Value::Bool(*flag));
        }
        Value::Object(map) if map.get("type").is_some_and(Value::is_string) => {
            for (key, item) in map {
                object.insert(key.clone(), item.clone());
            }
        }
        _ => {
            return Err(DesktopError::protocol(
                "config option values must be an option id, a boolean, or a typed value object",
            ));
        }
    }
    Ok(params)
}

/// Maps transport failures to typed desktop errors (F15).
pub fn map_transport_error(error: TransportError) -> DesktopError {
    match error {
        TransportError::NotRunning => DesktopError::not_ready("The agent process is not running"),
        TransportError::Timeout { method, timeout_ms } => DesktopError::outcome_unknown(format!(
            "{method} did not answer within {timeout_ms} ms; the outcome is unknown"
        )),
        TransportError::Remote(rpc) => map_rpc(&rpc),
        TransportError::Io(message) => DesktopError::io(message),
        TransportError::TooManyPending(count) => DesktopError::limit_exceeded(format!(
            "{count} control requests are already pending"
        )),
        TransportError::Exited(info) => DesktopError::outcome_unknown(format!(
            "The agent exited (status {:?}, signal {:?}) before answering",
            info.status, info.signal
        )),
    }
}

/// Maps a JSON-RPC error including its `data` field. Agents put the actual
/// cause there (`claude-agent-acp` answers `-32603 "Internal error: …"` with
/// `data.errorKind`), so matching on `message` alone would lose it.
pub fn map_rpc(rpc: &jsonrpc::RpcError) -> DesktopError {
    let data = match &rpc.data {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let combined = if data.is_empty() { rpc.message.clone() } else { format!("{}: {}", rpc.message, data) };
    map_rpc_error(&combined, rpc.code)
}

pub fn map_rpc_error(message: &str, code: i64) -> DesktopError {
    let lower = message.to_ascii_lowercase();
    if code == jsonrpc::METHOD_NOT_FOUND {
        return DesktopError::unsupported(format!("The agent does not support this operation: {message}"));
    }
    if lower.contains("authentication") || lower.contains("auth_required") || lower.contains("not authenticated") || lower.contains("not logged in") {
        return DesktopError::auth_required(message.to_string());
    }
    DesktopError::protocol(format!("The agent rejected the request: {message}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::RpcError;

    #[test]
    fn set_config_option_params_follow_the_typed_schema() {
        assert_eq!(
            set_config_option_params("s", "model", &json!("opus")).unwrap(),
            json!({"sessionId": "s", "configId": "model", "type": "id", "value": "opus"})
        );
        assert_eq!(
            set_config_option_params("s", "flag", &json!(true)).unwrap(),
            json!({"sessionId": "s", "configId": "flag", "type": "boolean", "value": true})
        );
        assert_eq!(
            set_config_option_params("s", "x", &json!({"type": "_vendor", "value": {"a": 1}})).unwrap()["type"],
            "_vendor"
        );
        assert!(set_config_option_params("s", "x", &json!(42)).is_err());
    }

    #[test]
    fn rpc_data_is_part_of_the_message_and_codes_are_typed() {
        let limited = map_rpc(&RpcError {
            code: -32603,
            message: "Internal error: You've hit your session limit · resets 12:20am".into(),
            data: Some(json!({"errorKind": "rate_limit"})),
        });
        assert!(limited.message.contains("rate_limit"));
        let missing = map_transport_error(TransportError::Remote(RpcError { code: -32601, message: "Method not found".into(), data: None }));
        assert_eq!(missing.code, crate::ErrorCode::Unsupported);
        let timeout = map_transport_error(TransportError::Timeout { method: "session/prompt".into(), timeout_ms: 30000 });
        assert_eq!(timeout.code, crate::ErrorCode::OutcomeUnknown);
        let auth = map_rpc_error("Not logged in · Please run /login", -32000);
        assert_eq!(auth.code, crate::ErrorCode::AuthRequired);
    }
}
