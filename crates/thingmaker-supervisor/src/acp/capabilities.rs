//! Initialize request construction and the attachment-scoped capability
//! snapshot (PRO-01, PRO-02, PRO-04).
//!
//! Control availability is derived from this snapshot, never from guessed
//! product names. The desktop advertises no client capabilities it has not
//! implemented.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{ClientIdentity, PROTOCOL_VERSION};
use crate::error::DesktopError;

/// The extension request that injects input into the turn that is running,
/// as `claude-agent-acp` names it and advertises under
/// `InitializeResponse._meta.steering.supported`. The Codex bridge answers to
/// the same name, so steering is one call whichever agent is on the other end.
pub const STEER_METHOD: &str = "_session/steering";

/// `initialize` params: protocol v1, our identity, and only implemented client
/// capabilities. The desktop declares no filesystem or terminal callbacks, so
/// agents read and write files themselves under their own permission mode
/// rather than asking this process to do it.
pub fn initialize_params(client: &ClientIdentity) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientInfo": {
            "name": client.name,
            "title": client.title,
            "version": client.version,
        },
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false }
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodSummary {
    /// `terminal`, `agent` or a vendor value.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySnapshot {
    pub protocol_version: u64,
    pub agent_name: String,
    pub agent_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_title: Option<String>,
    pub prompt_image: bool,
    pub prompt_audio: bool,
    pub prompt_embedded_context: bool,
    /// Whether input can be injected into a running turn ([`STEER_METHOD`]).
    pub supports_steering: bool,
    pub supports_load: bool,
    pub supports_fork: bool,
    pub supports_additional_directories: bool,
    pub supports_mcp: bool,
    pub auth_methods: Vec<AuthMethodSummary>,
    /// The raw initialize result for inspection; it is small and secret-free.
    pub raw: Value,
}

impl CapabilitySnapshot {
    /// Reads an ACP v1 `initialize` result. Fails visibly on any other
    /// protocol version: a silent downgrade would leave controls on screen
    /// that the agent cannot honour.
    pub fn from_initialize(result: &Value) -> Result<Self, DesktopError> {
        let object = result
            .as_object()
            .ok_or_else(|| DesktopError::protocol("initialize result is not an object"))?;
        let protocol_version = object
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| DesktopError::protocol("initialize result omitted protocolVersion"))?;
        if protocol_version != PROTOCOL_VERSION {
            return Err(DesktopError::protocol(format!(
                "the agent negotiated ACP protocol version {protocol_version}; this desktop drives version {PROTOCOL_VERSION}. Update the agent or its adapter."
            )));
        }
        let info = object
            .get("agentInfo")
            .and_then(Value::as_object)
            .ok_or_else(|| DesktopError::protocol("initialize result omitted agentInfo"))?;
        let agent_name = info
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| DesktopError::protocol("initialize agentInfo omitted name"))?
            .to_string();
        let agent_version = info
            .get("version")
            .and_then(Value::as_str)
            .ok_or_else(|| DesktopError::protocol("initialize agentInfo omitted version"))?
            .to_string();

        let capabilities = object.get("agentCapabilities").cloned().unwrap_or(Value::Null);
        let prompt = capabilities.get("promptCapabilities").cloned().unwrap_or(Value::Null);
        let session = capabilities.get("sessionCapabilities").cloned().unwrap_or(Value::Null);
        let flag = |value: &Value, key: &str| value.get(key).is_some_and(|v| v.as_bool() != Some(false) && !v.is_null());
        let steering = object
            .get("_meta")
            .and_then(|meta| meta.get("steering"))
            .and_then(|steering| steering.get("supported"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let auth_methods = object
            .get("authMethods")
            .and_then(Value::as_array)
            .map(|methods| {
                methods
                    .iter()
                    .map(|method| AuthMethodSummary {
                        kind: method.get("type").and_then(Value::as_str).unwrap_or("agent").to_string(),
                        method_id: method.get("id").and_then(Value::as_str).map(str::to_string),
                        name: method.get("name").and_then(Value::as_str).map(str::to_string),
                        description: method.get("description").and_then(Value::as_str).map(str::to_string),
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(Self {
            protocol_version,
            agent_name,
            agent_version,
            agent_title: info.get("title").and_then(Value::as_str).map(str::to_string),
            prompt_image: flag(&prompt, "image"),
            prompt_audio: flag(&prompt, "audio"),
            prompt_embedded_context: flag(&prompt, "embeddedContext"),
            supports_steering: steering,
            supports_load: flag(&capabilities, "loadSession"),
            supports_fork: flag(&session, "fork"),
            supports_additional_directories: flag(&session, "additionalDirectories"),
            supports_mcp: capabilities.get("mcpCapabilities").is_some_and(|value| !value.is_null()),
            auth_methods,
            raw: result.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_params_advertise_v1_and_no_unimplemented_capabilities() {
        let params = initialize_params(&ClientIdentity::default());
        assert_eq!(params["protocolVersion"], 1);
        assert!(params["clientInfo"]["version"].is_string());
        assert_eq!(params["clientCapabilities"]["fs"]["writeTextFile"], false);
    }

    #[test]
    fn snapshot_reads_the_claude_adapter_shape() {
        let result = json!({
            "protocolVersion": 1,
            "agentInfo": {"name": "@agentclientprotocol/claude-agent-acp", "title": "Claude Agent", "version": "0.76.0"},
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": {"image": true, "embeddedContext": true},
                "mcpCapabilities": {"http": true, "sse": true},
                "sessionCapabilities": {"fork": {}}
            },
            "authMethods": [{"id": "claude-login", "name": "Log in with Claude", "type": "terminal"}],
            "_meta": {"steering": {"supported": true}}
        });
        let snapshot = CapabilitySnapshot::from_initialize(&result).unwrap();
        assert!(snapshot.supports_steering && snapshot.supports_load && snapshot.supports_fork && snapshot.supports_mcp);
        assert!(snapshot.prompt_image && snapshot.prompt_embedded_context && !snapshot.prompt_audio);
        assert_eq!(snapshot.agent_title.as_deref(), Some("Claude Agent"));
        assert_eq!(snapshot.auth_methods[0].kind, "terminal");
        assert_eq!(snapshot.auth_methods[0].method_id.as_deref(), Some("claude-login"));
    }

    #[test]
    fn steering_is_absent_unless_advertised() {
        let plain = json!({"protocolVersion": 1, "agentInfo": {"name": "a", "version": "1"}});
        assert!(!CapabilitySnapshot::from_initialize(&plain).unwrap().supports_steering);
    }

    #[test]
    fn rejects_other_versions_and_malformed_results() {
        let v2 = json!({"protocolVersion": 2, "agentInfo": {"name": "k", "version": "1"}});
        let error = CapabilitySnapshot::from_initialize(&v2).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Protocol);
        assert!(error.message.contains("version 2"));
        assert!(CapabilitySnapshot::from_initialize(&json!({"protocolVersion": 1})).is_err());
        assert!(CapabilitySnapshot::from_initialize(&json!("nope")).is_err());
    }
}
