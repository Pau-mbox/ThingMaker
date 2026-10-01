//! JSON-RPC 2.0 envelope parsing and construction.
//!
//! Parsing validates the envelope only; method payloads are validated by the
//! adapter. Errors describe the shape problem and the byte count, never the
//! content, because frames may contain secrets.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
    Null,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Request {
        id: RequestId,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
    Response {
        id: RequestId,
        result: Option<Value>,
        error: Option<RpcError>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("frame of {bytes} bytes is not valid JSON")]
    InvalidJson { bytes: usize },
    #[error("invalid JSON-RPC envelope: {0}")]
    InvalidEnvelope(&'static str),
}

/// Parses one frame, which may be a single message or a batch array.
pub fn parse_messages(bytes: &[u8]) -> Result<Vec<Message>, ProtocolError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ProtocolError::InvalidJson {
        bytes: bytes.len(),
    })?;
    match value {
        Value::Array(items) => {
            if items.is_empty() {
                return Err(ProtocolError::InvalidEnvelope("empty batch"));
            }
            items.into_iter().map(parse_one).collect()
        }
        other => Ok(vec![parse_one(other)?]),
    }
}

fn parse_one(value: Value) -> Result<Message, ProtocolError> {
    let Value::Object(mut object) = value else {
        return Err(ProtocolError::InvalidEnvelope("message is not an object"));
    };
    // Codex's app-server leaves the version out of every message it sends
    // (the "JSON-RPC lite" its docs describe), so absence is accepted; a
    // version that is present and wrong is still refused.
    match object.get("jsonrpc") {
        None => {}
        Some(Value::String(version)) if version == "2.0" => {}
        _ => return Err(ProtocolError::InvalidEnvelope("unsupported jsonrpc version")),
    }
    let id = match object.remove("id") {
        None => None,
        Some(raw) => Some(
            serde_json::from_value::<RequestId>(raw)
                .map_err(|_| ProtocolError::InvalidEnvelope("id must be a number, string or null"))?,
        ),
    };
    if let Some(method) = object.remove("method") {
        let Value::String(method) = method else {
            return Err(ProtocolError::InvalidEnvelope("method is not a string"));
        };
        let params = match object.remove("params") {
            None | Some(Value::Null) => None,
            Some(params) => Some(params),
        };
        return Ok(match id {
            Some(id) if id != RequestId::Null => Message::Request { id, method, params },
            _ => Message::Notification { method, params },
        });
    }
    let result = object.remove("result");
    let error = object.remove("error");
    if result.is_none() && error.is_none() {
        return Err(ProtocolError::InvalidEnvelope(
            "message has neither method nor result/error",
        ));
    }
    let id = id.ok_or(ProtocolError::InvalidEnvelope("response without id"))?;
    let error = match error {
        None | Some(Value::Null) => None,
        Some(raw) => Some(
            serde_json::from_value::<RpcError>(raw)
                .map_err(|_| ProtocolError::InvalidEnvelope("invalid error object"))?,
        ),
    };
    Ok(Message::Response { id, result, error })
}

pub fn request(id: &RequestId, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// A notification. `Null` params are left out rather than sent as `null`:
/// Codex's `initialized` takes none, and a strict peer may refuse a `null`.
pub fn notification(method: &str, params: Value) -> Value {
    if params.is_null() {
        return json!({ "jsonrpc": "2.0", "method": method });
    }
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

pub fn response(id: &RequestId, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error_response(id: &RequestId, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Encodes one message as a single line without the trailing newline.
pub fn encode(message: &Value) -> Vec<u8> {
    serde_json::to_vec(message).expect("JSON values always serialize")
}

pub fn empty_object() -> Value {
    Value::Object(Map::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requests_notifications_and_responses() {
        let request = parse_messages(br#"{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"a":1}}"#).unwrap();
        assert_eq!(
            request,
            vec![Message::Request {
                id: RequestId::Number(7),
                method: "initialize".into(),
                params: Some(json!({"a": 1})),
            }]
        );
        let notification = parse_messages(br#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#).unwrap();
        assert!(matches!(&notification[0], Message::Notification { method, .. } if method == "session/update"));
        let null_id = parse_messages(br#"{"jsonrpc":"2.0","id":null,"method":"x"}"#).unwrap();
        assert!(matches!(&null_id[0], Message::Notification { .. }));
        let response = parse_messages(br#"{"jsonrpc":"2.0","id":"permission-1","result":{"ok":true}}"#).unwrap();
        assert_eq!(
            response,
            vec![Message::Response {
                id: RequestId::String("permission-1".into()),
                result: Some(json!({"ok": true})),
                error: None,
            }]
        );
        let error = parse_messages(br#"{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"Invalid params","data":"x"}}"#).unwrap();
        assert!(matches!(&error[0], Message::Response { error: Some(RpcError { code: -32602, .. }), .. }));
    }

    #[test]
    fn parses_batches_and_rejects_malformed_frames_without_leaking_content() {
        let batch = parse_messages(br#"[{"jsonrpc":"2.0","method":"a"},{"jsonrpc":"2.0","id":1,"result":1}]"#).unwrap();
        assert_eq!(batch.len(), 2);
        let secret = b"{\"jsonrpc\":\"2.0\",\"token\":\"sk-live-secret\"";
        let error = parse_messages(secret).unwrap_err();
        assert_eq!(error, ProtocolError::InvalidJson { bytes: secret.len() });
        assert!(!error.to_string().contains("secret"));
        assert_eq!(
            parse_messages(br#"{"jsonrpc":"1.0","method":"a"}"#).unwrap_err(),
            ProtocolError::InvalidEnvelope("unsupported jsonrpc version")
        );
        // Codex sends no version at all, and is understood.
        assert!(matches!(parse_messages(br#"{"id":1,"result":{}}"#).unwrap()[0], Message::Response { .. }));
        assert_eq!(
            parse_messages(br#"{"jsonrpc":"2.0","id":1}"#).unwrap_err(),
            ProtocolError::InvalidEnvelope("message has neither method nor result/error")
        );
        assert_eq!(
            parse_messages(br#"{"jsonrpc":"2.0","result":1}"#).unwrap_err(),
            ProtocolError::InvalidEnvelope("response without id")
        );
        assert_eq!(parse_messages(b"[]").unwrap_err(), ProtocolError::InvalidEnvelope("empty batch"));
    }

    #[test]
    fn builders_produce_wire_shapes() {
        let id = RequestId::Number(1);
        let value = request(&id, "session/cancel", json!({"sessionId": "s"}));
        assert_eq!(value["id"], 1);
        assert_eq!(value["method"], "session/cancel");
        let value = error_response(&RequestId::String("x".into()), METHOD_NOT_FOUND, "Client method not supported");
        assert_eq!(value["error"]["code"], -32601);
        assert_eq!(String::from_utf8(encode(&json!({"a":1}))).unwrap(), "{\"a\":1}");
    }
}
