//! What the session actor talks to: an ACP agent's own stdio, or the bridge
//! in front of an agent that speaks something else.
//!
//! Both present the same calls and the same stream of [`Incoming`], so the
//! actor has one code path for every provider.

use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::{
    agents::{AgentLaunch, codex::bridge::CodexBridge, gemini::bridge::GeminiBridge},
    transport::{ExitInfo, Incoming, LaunchSpec, RequestId, Transport, TransportError},
};

#[derive(Clone, Debug)]
pub enum Connection {
    /// The agent speaks ACP on its own stdio.
    Acp(Transport),
    /// Codex's app-server, translated to ACP by the bridge.
    Codex(CodexBridge),
    /// Antigravity's `agy`, translated to ACP by its bridge.
    Gemini(GeminiBridge),
}

impl Connection {
    pub async fn spawn(launch: &AgentLaunch, spec: LaunchSpec, generation: u64) -> Result<(Connection, mpsc::Receiver<Incoming>), TransportError> {
        match launch {
            AgentLaunch::Claude(_) => Transport::spawn(spec, generation).await.map(|(transport, incoming)| (Connection::Acp(transport), incoming)),
            AgentLaunch::Codex(options) => CodexBridge::spawn(spec, generation, options.clone())
                .await
                .map(|(bridge, incoming)| (Connection::Codex(bridge), incoming)),
            AgentLaunch::Gemini(options) => GeminiBridge::spawn(spec, generation, options.clone())
                .await
                .map(|(bridge, incoming)| (Connection::Gemini(bridge), incoming)),
        }
    }

    pub fn pid(&self) -> Option<u32> {
        match self {
            Self::Acp(transport) => transport.pid(),
            Self::Codex(bridge) => bridge.pid(),
            Self::Gemini(bridge) => bridge.pid(),
        }
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, TransportError> {
        match self {
            Self::Acp(transport) => transport.request(method, params, timeout).await,
            Self::Codex(bridge) => bridge.request(method, params, timeout).await,
            Self::Gemini(bridge) => bridge.request(method, params, timeout).await,
        }
    }

    pub async fn request_observed(&self, method: &str, params: Value, timeout: Duration, written: Option<oneshot::Sender<()>>) -> Result<Value, TransportError> {
        match self {
            Self::Acp(transport) => transport.request_observed(method, params, timeout, written).await,
            Self::Codex(bridge) => bridge.request_observed(method, params, timeout, written).await,
            Self::Gemini(bridge) => bridge.request_observed(method, params, timeout, written).await,
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), TransportError> {
        match self {
            Self::Acp(transport) => transport.notify(method, params).await,
            Self::Codex(bridge) => bridge.notify(method, params).await,
            Self::Gemini(bridge) => bridge.notify(method, params).await,
        }
    }

    pub async fn respond(&self, id: &RequestId, result: Value) -> Result<(), TransportError> {
        match self {
            Self::Acp(transport) => transport.respond(id, result).await,
            Self::Codex(bridge) => bridge.respond(id, result).await,
            Self::Gemini(bridge) => bridge.respond(id, result).await,
        }
    }

    pub async fn respond_error(&self, id: &RequestId, code: i64, message: &str) -> Result<(), TransportError> {
        match self {
            Self::Acp(transport) => transport.respond_error(id, code, message).await,
            Self::Codex(bridge) => bridge.respond_error(id, code, message).await,
            Self::Gemini(bridge) => bridge.respond_error(id, code, message).await,
        }
    }

    pub async fn shutdown(&self, budget: Duration) -> ExitInfo {
        match self {
            Self::Acp(transport) => transport.shutdown(budget).await,
            Self::Codex(bridge) => bridge.shutdown(budget).await,
            Self::Gemini(bridge) => bridge.shutdown(budget).await,
        }
    }
}
