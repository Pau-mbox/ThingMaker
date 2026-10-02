//! Codex's app-server, spoken to the session actor as ACP.
//!
//! The actor drives every provider with the same ACP v1 calls. Codex speaks
//! its own JSON-RPC protocol (`codex app-server`), so this bridge sits between
//! them inside the supervisor: it presents the same surface as
//! [`Transport`] — requests, notifications, responses, and a stream of
//! [`Incoming`] — and translates each way.
//!
//! | ACP (actor side) | Codex app-server |
//! | --- | --- |
//! | `initialize` | `initialize` + `initialized` |
//! | `session/new` / `session/load` | `thread/start` / `thread/resume` (history replayed as updates) |
//! | `session/set_config_option` | held here; applied on the next `turn/start` |
//! | `session/prompt` → `stopReason` at turn end | `turn/start`, then `turn/completed` |
//! | `_session/steering` | `turn/steer` |
//! | `session/cancel` | `turn/interrupt` |
//! | `session/request_permission` | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` |
//! | `session/update` | `item/*`, `turn/plan/updated`, `thread/tokenUsage/updated`, `account/rateLimits/updated` |
//!
//! The account's quota travels as a `usage_update` whose `_meta` carries a
//! ready [`QuotaSnapshot`] under [`QUOTA_META_KEY`], which the actor lifts
//! into a `Quota` event the same way it lifts Claude's.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde_json::{Map, Value, json};
use tokio::{
    sync::{mpsc, oneshot},
    time,
};

use super::{
    launch::{CodexLaunchOptions, approval_policy, initialize_params, sandbox_mode},
    quota::quota_from_rate_limits,
};
use crate::{
    acp::PROTOCOL_VERSION,
    agents::PermissionStance,
    transport::{ExitInfo, Incoming, LaunchSpec, RequestId, RpcError, Transport, TransportError, jsonrpc},
};

/// `_meta` key under which the bridge hands the actor a finished quota.
pub const QUOTA_META_KEY: &str = "_thingmaker/quota";

/// How long Codex gets to accept a `turn/start` before the prompt counts as
/// not written. The turn itself then runs for as long as it needs.
const TURN_START_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
enum ApprovalKind {
    /// `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`.
    Decision,
    /// The legacy `execCommandApproval` / `applyPatchApproval`.
    Review,
    /// `item/permissions/requestApproval`: declined by error, granted never.
    Permissions,
    /// `mcpServer/elicitation/request` from one of the session's own MCP
    /// servers: Codex asking whether a tool may run. The answer to send when
    /// it is allowed.
    Elicitation(Value),
}

struct State {
    thread_id: Option<String>,
    active_turn: Option<String>,
    pending_turn: Option<oneshot::Sender<Result<Value, TransportError>>>,
    model: Option<String>,
    effort: Option<String>,
    stance: PermissionStance,
    /// `model/list` data, for the config options and each model's efforts.
    models: Vec<Value>,
    /// Codex's own default model, from `thread/start`.
    default_model: Option<String>,
    approvals: HashMap<String, (RequestId, ApprovalKind)>,
    agent_version: String,
    /// Names of the MCP servers this session was given (`mcpServers`).
    session_servers: Vec<String>,
}

struct Inner {
    codex: Transport,
    out: mpsc::Sender<Incoming>,
    state: Mutex<State>,
    launch: CodexLaunchOptions,
    serial: AtomicU64,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// A live Codex attachment, addressed like a [`Transport`].
#[derive(Clone)]
pub struct CodexBridge {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for CodexBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexBridge").field("codex", &self.inner.codex).finish()
    }
}

impl CodexBridge {
    /// Starts `codex app-server` and the translation task.
    pub async fn spawn(spec: LaunchSpec, generation: u64, launch: CodexLaunchOptions) -> Result<(CodexBridge, mpsc::Receiver<Incoming>), TransportError> {
        let (codex, incoming) = Transport::spawn(spec, generation).await?;
        let (out, out_rx) = mpsc::channel(1024);
        let inner = Arc::new(Inner {
            codex,
            out,
            state: Mutex::new(State {
                thread_id: None,
                active_turn: None,
                pending_turn: None,
                model: launch.model.clone(),
                effort: launch.effort.clone(),
                stance: launch.permission_mode,
                models: Vec::new(),
                default_model: None,
                approvals: HashMap::new(),
                agent_version: String::new(),
                session_servers: Vec::new(),
            }),
            launch,
            serial: AtomicU64::new(1),
        });
        tokio::spawn(translate(Arc::clone(&inner), incoming));
        Ok((CodexBridge { inner }, out_rx))
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner.codex.pid()
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, TransportError> {
        self.request_observed(method, params, timeout, None).await
    }

    /// One ACP request, answered in ACP. `written` fires once the Codex call
    /// that carries it has been written — for a prompt, the `turn/start`.
    pub async fn request_observed(&self, method: &str, params: Value, timeout: Duration, written: Option<oneshot::Sender<()>>) -> Result<Value, TransportError> {
        let inner = &self.inner;
        match method {
            "initialize" => {
                let client = params.get("clientInfo").cloned().unwrap_or(Value::Null);
                let name = client.get("name").and_then(Value::as_str).unwrap_or("thingmaker");
                let title = client.get("title").and_then(Value::as_str).unwrap_or("ThingMaker");
                let version = client.get("version").and_then(Value::as_str).unwrap_or("0");
                let result = inner.codex.request("initialize", initialize_params(name, title, version), timeout).await?;
                inner.codex.notify("initialized", Value::Null).await?;
                let agent_version = result
                    .get("userAgent")
                    .and_then(Value::as_str)
                    .and_then(|agent| agent.split_whitespace().next())
                    .and_then(|first| first.split_once('/'))
                    .map(|(_, version)| version.to_string())
                    .unwrap_or_default();
                inner.state().agent_version = agent_version.clone();
                Ok(json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "agentInfo": { "name": "codex-app-server", "title": "Codex", "version": agent_version },
                    "agentCapabilities": {
                        "loadSession": true,
                        "promptCapabilities": { "image": true, "embeddedContext": true },
                        "mcpCapabilities": { "http": true }
                    },
                    "authMethods": [],
                    "_meta": { "steering": { "supported": true } }
                }))
            }
            "session/new" | "session/load" => self.open_thread(method == "session/load", &params, timeout).await,
            "session/set_config_option" => {
                let id = params.get("configId").and_then(Value::as_str).unwrap_or_default();
                let value = params.get("value").and_then(Value::as_str).map(str::to_string);
                {
                    let mut state = inner.state();
                    match id {
                        "model" => state.model = value,
                        "effort" => state.effort = value.filter(|effort| effort != "default"),
                        "mode" => {
                            state.stance = match value.as_deref() {
                                Some("workspace-write") => PermissionStance::AcceptEdits,
                                _ => PermissionStance::ReadOnly,
                            }
                        }
                        other => return Err(remote(jsonrpc::INVALID_PARAMS, &format!("Codex has no option {other}"))),
                    }
                }
                Ok(json!({ "configOptions": self.config_options() }))
            }
            "session/prompt" => {
                let (thread_id, input, model, effort, stance) = {
                    let state = inner.state();
                    let Some(thread_id) = state.thread_id.clone() else {
                        return Err(remote(jsonrpc::INVALID_PARAMS, "no Codex thread is open"));
                    };
                    (thread_id, user_input(params.get("prompt")), state.model.clone(), state.effort.clone(), state.stance)
                };
                let (tx, rx) = oneshot::channel();
                inner.state().pending_turn = Some(tx);
                let mut turn = json!({ "threadId": thread_id, "input": input, "approvalPolicy": approval_policy(stance), "sandboxPolicy": sandbox_policy(stance, &inner.launch) });
                if let Some(model) = model {
                    turn["model"] = Value::String(model);
                }
                if let Some(effort) = effort {
                    turn["effort"] = Value::String(effort);
                }
                match inner.codex.request_observed("turn/start", turn, TURN_START_TIMEOUT, written).await {
                    Ok(result) => {
                        if let Some(id) = result.get("turn").and_then(|turn| turn.get("id")).and_then(Value::as_str) {
                            let mut state = inner.state();
                            // A turn that finished before its start was
                            // acknowledged has already resolved the prompt.
                            if state.pending_turn.is_some() {
                                state.active_turn = Some(id.to_string());
                            }
                        }
                    }
                    Err(error) => {
                        inner.state().pending_turn = None;
                        return Err(error);
                    }
                }
                match time::timeout(timeout, rx).await {
                    Ok(Ok(outcome)) => outcome,
                    Ok(Err(_)) => Err(TransportError::NotRunning),
                    Err(_) => Err(TransportError::Timeout { method: "session/prompt".into(), timeout_ms: timeout.as_millis() as u64 }),
                }
            }
            crate::acp::capabilities::STEER_METHOD => {
                let (thread_id, turn_id) = {
                    let state = inner.state();
                    (state.thread_id.clone(), state.active_turn.clone())
                };
                let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) else {
                    return Err(remote(jsonrpc::INVALID_PARAMS, "no Codex turn is running to steer"));
                };
                inner
                    .codex
                    .request("turn/steer", json!({ "threadId": thread_id, "expectedTurnId": turn_id, "input": user_input(params.get("prompt")) }), timeout)
                    .await?;
                Ok(json!({}))
            }
            "session/close" => Ok(json!({})),
            other => Err(remote(jsonrpc::METHOD_NOT_FOUND, &format!("Codex bridge does not implement {other}"))),
        }
    }

    async fn open_thread(&self, resume: bool, params: &Value, timeout: Duration) -> Result<Value, TransportError> {
        let inner = &self.inner;
        let (model, stance) = {
            let state = inner.state();
            (state.model.clone(), state.stance)
        };
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| inner.launch.root.to_string_lossy().into_owned());
        let mut thread = json!({ "cwd": cwd, "approvalPolicy": approval_policy(stance), "sandbox": sandbox_mode(stance) });
        if let Some(model) = &model {
            thread["model"] = Value::String(model.clone());
        }
        inner.state().session_servers = params
            .get("mcpServers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|server| server.get("name").and_then(Value::as_str).map(str::to_string))
            .collect();
        let mut config = inner.launch.config.clone();
        if let Some(Value::Object(servers)) = mcp_config(params.get("mcpServers")) {
            config.extend(servers);
        }
        if !config.is_empty() {
            thread["config"] = Value::Object(config);
        }
        if let Some(instructions) = inner.launch.developer_instructions.as_ref().filter(|text| !text.trim().is_empty()) {
            thread["developerInstructions"] = Value::String(instructions.clone());
        }
        let result = if resume {
            let thread_id = params.get("sessionId").and_then(Value::as_str).unwrap_or_default();
            thread["threadId"] = Value::String(thread_id.to_string());
            inner.codex.request("thread/resume", thread, timeout).await?
        } else {
            inner.codex.request("thread/start", thread, timeout).await?
        };
        let thread_id = result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| remote(jsonrpc::INTERNAL_ERROR, "Codex opened a thread without an id"))?
            .to_string();
        {
            let mut state = inner.state();
            state.thread_id = Some(thread_id.clone());
            state.default_model = result.get("model").and_then(Value::as_str).map(str::to_string);
        }
        if let Ok(list) = inner.codex.request("model/list", json!({ "limit": 100 }), timeout).await {
            inner.state().models = list.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        }
        if resume {
            // A load replays the session as updates before it answers, as the
            // ACP agents do.
            let turns = result.get("thread").and_then(|thread| thread.get("turns")).and_then(Value::as_array).cloned().unwrap_or_default();
            for turn in &turns {
                for item in turn.get("items").and_then(Value::as_array).into_iter().flatten() {
                    for update in item_updates(item, true) {
                        send_update(inner, &thread_id, update).await;
                    }
                }
            }
        }
        Ok(json!({ "sessionId": thread_id, "configOptions": self.config_options() }))
    }

    /// The config options the actor reads the model, effort and mode from.
    fn config_options(&self) -> Value {
        let state = self.inner.state();
        let current_model = state.model.clone().or_else(|| state.default_model.clone()).or_else(|| {
            state
                .models
                .iter()
                .find(|model| model.get("isDefault").and_then(Value::as_bool) == Some(true))
                .and_then(|model| model.get("id").and_then(Value::as_str).map(str::to_string))
        });
        let visible: Vec<&Value> = state.models.iter().filter(|model| !model.get("hidden").and_then(Value::as_bool).unwrap_or(false)).collect();
        let model_options: Vec<Value> = visible
            .iter()
            .filter_map(|model| {
                let id = model.get("id").and_then(Value::as_str)?;
                Some(json!({ "value": id, "name": model.get("displayName").and_then(Value::as_str).unwrap_or(id) }))
            })
            .collect();
        let current = visible.iter().find(|model| model.get("id").and_then(Value::as_str) == current_model.as_deref());
        let efforts: Vec<Value> = current
            .and_then(|model| model.get("supportedReasoningEfforts"))
            .and_then(Value::as_array)
            .map(|efforts| {
                efforts
                    .iter()
                    .filter_map(|effort| effort.get("reasoningEffort").and_then(Value::as_str))
                    .map(|effort| json!({ "value": effort, "name": capitalise(effort) }))
                    .collect()
            })
            .unwrap_or_default();
        let current_effort = state
            .effort
            .clone()
            .or_else(|| current.and_then(|model| model.get("defaultReasoningEffort")).and_then(Value::as_str).map(str::to_string));
        json!([
            { "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": sandbox_mode(state.stance),
              "options": [ { "value": "workspace-write", "name": "Edit the workspace" }, { "value": "read-only", "name": "Read only" } ] },
            { "id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": current_effort, "options": efforts },
            { "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": current_model, "options": model_options }
        ])
    }

    pub async fn notify(&self, method: &str, _params: Value) -> Result<(), TransportError> {
        if method != "session/cancel" {
            return Ok(());
        }
        let (thread_id, turn_id) = {
            let state = self.inner.state();
            (state.thread_id.clone(), state.active_turn.clone())
        };
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            let codex = self.inner.codex.clone();
            // Fire and forget, like the notification it stands for; the turn
            // settles through `turn/completed` with `interrupted`.
            tokio::spawn(async move {
                let _ = codex.request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id }), Duration::from_secs(10)).await;
            });
        }
        Ok(())
    }

    /// The actor's answer to a permission request, in Codex's words.
    pub async fn respond(&self, id: &RequestId, result: Value) -> Result<(), TransportError> {
        let Some((codex_id, kind)) = self.take_approval(id) else { return Ok(()) };
        let allowed = result
            .get("outcome")
            .and_then(|outcome| outcome.get("optionId"))
            .and_then(Value::as_str)
            .is_some_and(|option| option.starts_with("allow"));
        match kind {
            ApprovalKind::Decision => self.inner.codex.respond(&codex_id, json!({ "decision": if allowed { "accept" } else { "decline" } })).await,
            ApprovalKind::Review => {
                let decision = if allowed { json!("approved") } else { json!({ "denied": { "rejection": "refused by the workspace's trust" } }) };
                self.inner.codex.respond(&codex_id, json!({ "decision": decision })).await
            }
            ApprovalKind::Permissions => self.inner.codex.respond_error(&codex_id, jsonrpc::INVALID_REQUEST, "extra permissions are not granted by this desktop").await,
            ApprovalKind::Elicitation(content) => {
                let answer = if allowed { json!({ "action": "accept", "content": content, "_meta": null }) } else { json!({ "action": "decline", "content": null, "_meta": null }) };
                self.inner.codex.respond(&codex_id, answer).await
            }
        }
    }

    pub async fn respond_error(&self, id: &RequestId, code: i64, message: &str) -> Result<(), TransportError> {
        match self.take_approval(id) {
            Some((codex_id, _)) => self.inner.codex.respond_error(&codex_id, code, message).await,
            None => Ok(()),
        }
    }

    fn take_approval(&self, id: &RequestId) -> Option<(RequestId, ApprovalKind)> {
        let RequestId::String(key) = id else { return None };
        self.inner.state().approvals.remove(key)
    }

    pub async fn shutdown(&self, budget: Duration) -> ExitInfo {
        self.inner.codex.shutdown(budget).await
    }
}

fn remote(code: i64, message: &str) -> TransportError {
    TransportError::Remote(RpcError { code, message: message.to_string(), data: None })
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// The per-turn sandbox policy for a stance.
fn sandbox_policy(stance: PermissionStance, launch: &CodexLaunchOptions) -> Value {
    match stance {
        PermissionStance::AcceptEdits => json!({
            "type": "workspaceWrite",
            "writableRoots": [launch.root.to_string_lossy()],
            "networkAccess": true,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false
        }),
        PermissionStance::ReadOnly => json!({ "type": "readOnly", "networkAccess": false }),
    }
}

/// How long Codex waits on a tool of a session's own MCP server.
pub const SESSION_TOOL_TIMEOUT_SECS: u64 = 1800;

/// ACP `mcpServers` as Codex config overrides (`mcp_servers.<name>`), so a
/// session's servers are the session's and the user's `config.toml` is not
/// touched.
fn mcp_config(servers: Option<&Value>) -> Option<Value> {
    let servers = servers?.as_array().filter(|servers| !servers.is_empty())?;
    let mut config = Map::new();
    for server in servers {
        let Some(name) = server.get("name").and_then(Value::as_str) else { continue };
        let entry = if let Some(url) = server.get("url").and_then(Value::as_str) {
            json!({ "url": url })
        } else {
            let env: Map<String, Value> = server
                .get("env")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|pair| Some((pair.get("name")?.as_str()?.to_string(), pair.get("value")?.clone())))
                .collect();
            // A session's servers are the desktop's own: long tool calls
            // (`await_jobs` waits for minutes) are the point, so Codex's
            // 60-second default would cut them.
            json!({
                "command": server.get("command").cloned().unwrap_or(Value::Null),
                "args": server.get("args").cloned().unwrap_or_else(|| json!([])),
                "env": env,
                "startup_timeout_sec": 30,
                "tool_timeout_sec": SESSION_TOOL_TIMEOUT_SECS
            })
        };
        config.insert(format!("mcp_servers.{name}"), entry);
    }
    Some(Value::Object(config))
}

/// The accepting answer to an approval form: each field's default, else the
/// affirmative choice (`true`, an option that reads as approval, the first
/// option), else empty.
fn form_answer(schema: Option<&Value>) -> Value {
    let mut content = Map::new();
    let properties = schema.and_then(|schema| schema.get("properties")).and_then(Value::as_object);
    for (name, property) in properties.into_iter().flatten() {
        let value = if let Some(default) = property.get("default") {
            default.clone()
        } else if let Some(options) = property.get("enum").and_then(Value::as_array) {
            let affirmative = options.iter().find(|option| {
                option.as_str().is_some_and(|text| {
                    let text = text.to_ascii_lowercase();
                    ["allow", "approve", "accept", "yes", "run"].iter().any(|word| text.contains(word)) && !text.contains("always")
                })
            });
            affirmative.or(options.first()).cloned().unwrap_or(Value::Null)
        } else {
            match property.get("type").and_then(Value::as_str) {
                Some("boolean") => Value::Bool(true),
                Some("number") | Some("integer") => json!(0),
                Some("array") => json!([]),
                _ => Value::String(String::new()),
            }
        };
        content.insert(name.clone(), value);
    }
    Value::Object(content)
}

/// ACP prompt blocks as Codex `UserInput`.
fn user_input(prompt: Option<&Value>) -> Value {
    let blocks = prompt.and_then(Value::as_array).cloned().unwrap_or_default();
    let mut input = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    input.push(json!({ "type": "text", "text": text, "text_elements": [] }));
                }
            }
            Some("image") => {
                let mime = block.get("mimeType").and_then(Value::as_str).unwrap_or("image/png");
                if let Some(data) = block.get("data").and_then(Value::as_str) {
                    input.push(json!({ "type": "image", "url": format!("data:{mime};base64,{data}") }));
                }
            }
            Some("resource_link") => {
                let uri = block.get("uri").and_then(Value::as_str).unwrap_or_default();
                let path = uri.strip_prefix("file://").unwrap_or(uri);
                input.push(json!({ "type": "text", "text": format!("@{path}"), "text_elements": [] }));
            }
            Some("resource") => {
                let resource = block.get("resource").cloned().unwrap_or(Value::Null);
                let uri = resource.get("uri").and_then(Value::as_str).unwrap_or_default();
                let text = resource.get("text").and_then(Value::as_str).unwrap_or_default();
                input.push(json!({ "type": "text", "text": format!("{uri}\n```\n{text}\n```"), "text_elements": [] }));
            }
            _ => {}
        }
    }
    Value::Array(input)
}

async fn send_update(inner: &Inner, thread_id: &str, update: Value) {
    let _ = inner
        .out
        .send(Incoming::Notification {
            method: "session/update".into(),
            params: Some(json!({ "sessionId": thread_id, "update": update })),
        })
        .await;
}

fn status_of(item: &Value, completed: bool) -> &'static str {
    match item.get("status").and_then(Value::as_str) {
        Some("completed") => "completed",
        Some("failed") | Some("declined") | Some("interrupted") => "failed",
        Some("inProgress") => "in_progress",
        _ if completed => "completed",
        _ => "in_progress",
    }
}

fn text_of(content: Option<&Value>) -> String {
    content
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One Codex thread item as ACP updates: messages as full messages, tools as
/// tool calls. `completed` marks the item's final state (and every item in a
/// replay).
pub fn item_updates(item: &Value, completed: bool) -> Vec<Value> {
    let id = item.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let tool = |title: String, tool_kind: &str, name: &str, raw_input: Value, raw_output: Option<Value>, locations: Option<Value>| {
        let mut update = json!({
            "sessionUpdate": if completed { "tool_call_update" } else { "tool_call" },
            "toolCallId": id,
            "title": title,
            "kind": tool_kind,
            "name": name,
            "status": status_of(item, completed),
            "rawInput": raw_input,
        });
        if let Some(output) = raw_output.filter(|_| completed) {
            update["rawOutput"] = output;
        }
        if let Some(locations) = locations {
            update["locations"] = locations;
        }
        vec![update]
    };
    match kind {
        "userMessage" if completed => {
            let text = text_of(item.get("content"));
            if text.is_empty() {
                return Vec::new();
            }
            vec![json!({ "sessionUpdate": "user_message", "messageId": id, "content": [{ "type": "text", "text": text }] })]
        }
        "agentMessage" if completed => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
            vec![json!({ "sessionUpdate": "agent_message", "messageId": id, "content": [{ "type": "text", "text": text }] })]
        }
        "reasoning" if completed => {
            let summary = item
                .get("summary")
                .and_then(Value::as_array)
                .map(|parts| parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n\n"))
                .unwrap_or_default();
            if summary.is_empty() {
                return Vec::new();
            }
            vec![json!({ "sessionUpdate": "agent_thought", "messageId": id, "content": [{ "type": "text", "text": summary }] })]
        }
        "commandExecution" => {
            let command = item.get("command").and_then(Value::as_str).unwrap_or_default().to_string();
            tool(
                command.clone(),
                "execute",
                "shell",
                // Codex parses the command itself into reads, listings and
                // searches; the transcript labels steps from them.
                json!({ "command": command, "cwd": item.get("cwd"), "actions": item.get("commandActions") }),
                Some(json!({ "exitCode": item.get("exitCode"), "output": item.get("aggregatedOutput"), "durationMs": item.get("durationMs") })),
                None,
            )
        }
        "fileChange" => {
            let changes = item.get("changes").and_then(Value::as_array).cloned().unwrap_or_default();
            let paths: Vec<Value> = changes.iter().filter_map(|change| change.get("path").cloned()).map(|path| json!({ "path": path })).collect();
            let title = match changes.len() {
                1 => format!("Edit {}", changes[0].get("path").and_then(Value::as_str).unwrap_or("a file")),
                n => format!("Edit {n} files"),
            };
            tool(title, "edit", "apply_patch", json!({ "changes": changes.iter().map(|change| json!({ "path": change.get("path"), "kind": change.get("kind") })).collect::<Vec<_>>() }), Some(json!({ "changes": changes })), Some(Value::Array(paths)))
        }
        "mcpToolCall" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or_default();
            let name = item.get("tool").and_then(Value::as_str).unwrap_or_default();
            tool(format!("{server} · {name}"), "other", name, item.get("arguments").cloned().unwrap_or(Value::Null), Some(json!({ "result": item.get("result"), "error": item.get("error") })), None)
        }
        "dynamicToolCall" => {
            let name = item.get("tool").and_then(Value::as_str).unwrap_or_default();
            tool(name.to_string(), "other", name, item.get("arguments").cloned().unwrap_or(Value::Null), Some(json!({ "contentItems": item.get("contentItems"), "success": item.get("success") })), None)
        }
        "collabAgentToolCall" => {
            let collab = item.get("tool").and_then(Value::as_str).unwrap_or("spawnAgent");
            let prompt = item.get("prompt").and_then(Value::as_str).unwrap_or_default();
            let title = prompt.lines().next().unwrap_or(collab).chars().take(80).collect::<String>();
            tool(
                if title.is_empty() { collab.to_string() } else { title },
                "think",
                &format!("collab:{collab}"),
                json!({ "collab": collab, "prompt": prompt, "model": item.get("model"), "reasoningEffort": item.get("reasoningEffort"), "receiverThreadIds": item.get("receiverThreadIds") }),
                Some(json!({ "agentsStates": item.get("agentsStates") })),
                None,
            )
        }
        "webSearch" => {
            let query = item.get("query").and_then(Value::as_str).unwrap_or_default();
            tool(format!("Search: {query}"), "fetch", "web_search", json!({ "query": query }), Some(json!({ "results": item.get("results") })), None)
        }
        "imageView" => {
            let path = item.get("path").cloned().unwrap_or(Value::Null);
            tool("View image".into(), "read", "view_image", json!({ "path": path }), None, Some(json!([{ "path": path }])))
        }
        "imageGeneration" => {
            let saved = item.get("savedPath").cloned().unwrap_or(Value::Null);
            tool(
                "Generate image".into(),
                "other",
                "image_generation",
                json!({ "prompt": item.get("revisedPrompt") }),
                Some(json!({ "savedPath": saved, "revisedPrompt": item.get("revisedPrompt"), "failure": item.get("failure") })),
                saved.as_str().map(|path| json!([{ "path": path }])),
            )
        }
        _ => Vec::new(),
    }
}

/// The turn's outcome as the answer to its `session/prompt`.
fn turn_outcome(turn: &Value) -> Result<Value, TransportError> {
    match turn.get("status").and_then(Value::as_str) {
        Some("interrupted") => Ok(json!({ "stopReason": "cancelled" })),
        Some("failed") => {
            let error = turn.get("error").cloned().unwrap_or(Value::Null);
            let message = error.get("message").and_then(Value::as_str).unwrap_or("the turn failed");
            let info = error.get("codexErrorInfo").cloned().unwrap_or(Value::Null);
            let kind = match info.as_str() {
                // The words the runner reads as "the account is spent".
                Some("usageLimitExceeded") | Some("rateLimitExceeded") => "rate_limit".to_string(),
                Some(other) => other.to_string(),
                None => info.as_object().and_then(|object| object.keys().next().cloned()).unwrap_or_else(|| "other".into()),
            };
            Err(TransportError::Remote(RpcError {
                code: jsonrpc::INTERNAL_ERROR,
                message: format!("Internal error: {message}"),
                data: Some(json!({ "errorKind": kind })),
            }))
        }
        _ => Ok(json!({ "stopReason": "end_turn" })),
    }
}

async fn translate(inner: Arc<Inner>, mut incoming: mpsc::Receiver<Incoming>) {
    while let Some(message) = incoming.recv().await {
        match message {
            Incoming::Notification { method, params } => on_notification(&inner, &method, params.unwrap_or(Value::Null)).await,
            Incoming::Request { id, method, params } => on_request(&inner, id, &method, params.unwrap_or(Value::Null)).await,
            Incoming::Exited(info) => {
                if let Some(pending) = inner.state().pending_turn.take() {
                    let _ = pending.send(Err(TransportError::Exited(info.clone())));
                }
                let _ = inner.out.send(Incoming::Exited(info)).await;
            }
            other => {
                let _ = inner.out.send(other).await;
            }
        }
    }
}

async fn on_notification(inner: &Inner, method: &str, params: Value) {
    let Some(thread_id) = inner.state().thread_id.clone() else { return };
    // Notifications about a subagent's own thread are its business; the
    // session shows the collab call that raised it instead.
    if let Some(routed) = params.get("threadId").and_then(Value::as_str)
        && routed != thread_id
    {
        return;
    }
    match method {
        "item/agentMessage/delta" => {
            let item = params.get("itemId").and_then(Value::as_str).unwrap_or_default();
            let delta = params.get("delta").and_then(Value::as_str).unwrap_or_default();
            send_update(inner, &thread_id, json!({ "sessionUpdate": "agent_message_chunk", "messageId": item, "content": { "type": "text", "text": delta } })).await;
        }
        "item/reasoning/summaryTextDelta" => {
            let item = params.get("itemId").and_then(Value::as_str).unwrap_or_default();
            let delta = params.get("delta").and_then(Value::as_str).unwrap_or_default();
            send_update(inner, &thread_id, json!({ "sessionUpdate": "agent_thought_chunk", "messageId": item, "content": { "type": "text", "text": delta } })).await;
        }
        "item/started" | "item/completed" => {
            if let Some(item) = params.get("item") {
                for update in item_updates(item, method == "item/completed") {
                    send_update(inner, &thread_id, update).await;
                }
            }
        }
        "turn/plan/updated" => {
            let entries: Vec<Value> = params
                .get("plan")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|step| {
                    let status = match step.get("status").and_then(Value::as_str) {
                        Some("inProgress") => "in_progress",
                        Some("completed") => "completed",
                        _ => "pending",
                    };
                    json!({ "content": step.get("step"), "status": status })
                })
                .collect();
            send_update(inner, &thread_id, json!({ "sessionUpdate": "plan", "entries": entries })).await;
        }
        "thread/tokenUsage/updated" => {
            let usage = params.get("tokenUsage").cloned().unwrap_or(Value::Null);
            let used = usage.get("last").and_then(|last| last.get("totalTokens")).and_then(Value::as_u64);
            let size = usage.get("modelContextWindow").and_then(Value::as_u64);
            send_update(inner, &thread_id, json!({ "sessionUpdate": "usage_update", "used": used, "size": size })).await;
        }
        "account/rateLimits/updated" => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            if let Some(quota) = params.get("rateLimits").and_then(|limits| quota_from_rate_limits(limits, now)) {
                let meta = json!({ QUOTA_META_KEY: quota });
                send_update(inner, &thread_id, json!({ "sessionUpdate": "usage_update", "_meta": meta })).await;
            }
        }
        "thread/name/updated" => {
            if let Some(name) = params.get("name").and_then(Value::as_str) {
                send_update(inner, &thread_id, json!({ "sessionUpdate": "session_info_update", "title": name })).await;
            }
        }
        "turn/completed" => {
            let turn = params.get("turn").cloned().unwrap_or(Value::Null);
            let pending = {
                let mut state = inner.state();
                state.active_turn = None;
                state.pending_turn.take()
            };
            if let Some(pending) = pending {
                let _ = pending.send(turn_outcome(&turn));
            }
        }
        "error" if params.get("willRetry").and_then(Value::as_bool) != Some(true) => {
            let message = params.get("error").and_then(|error| error.get("message")).and_then(Value::as_str).unwrap_or("error");
            let _ = inner.out.send(Incoming::StderrLine(format!("Codex: {message}").into_bytes())).await;
        }
        _ => {}
    }
}

async fn on_request(inner: &Inner, id: RequestId, method: &str, params: Value) {
    if method == "mcpServer/elicitation/request" {
        let server = params.get("serverName").and_then(Value::as_str).unwrap_or_default();
        // Only a form from a server this session was given is Codex asking
        // whether one of the desktop's own tools may run. Anything else
        // wants a person to type something, and there is no person here.
        let own = inner.state().session_servers.iter().any(|name| name == server);
        if !own || params.get("mode").and_then(Value::as_str) != Some("form") {
            let _ = inner.codex.respond(&id, json!({ "action": "decline", "content": null, "_meta": null })).await;
            return;
        }
    }
    let approval = match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => Some(ApprovalKind::Decision),
        "execCommandApproval" | "applyPatchApproval" => Some(ApprovalKind::Review),
        "item/permissions/requestApproval" => Some(ApprovalKind::Permissions),
        "mcpServer/elicitation/request" => Some(ApprovalKind::Elicitation(form_answer(params.get("requestedSchema")))),
        _ => None,
    };
    let Some(kind) = approval else {
        // Tools the desktop defines, user-input questions and MCP forms are
        // answered once there is something to answer them with; until then,
        // refused rather than left hanging a turn.
        let _ = inner.codex.respond_error(&id, jsonrpc::METHOD_NOT_FOUND, &format!("ThingMaker does not answer {method}")).await;
        return;
    };
    let key = format!("codex-approval-{}", inner.serial.fetch_add(1, Ordering::Relaxed));
    let title = match method {
        "mcpServer/elicitation/request" => params.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| "Run a team tool".into()),
        "item/fileChange/requestApproval" | "applyPatchApproval" => "Apply a patch".to_string(),
        "item/permissions/requestApproval" => format!("Grant extra permissions{}", params.get("reason").and_then(Value::as_str).map(|reason| format!(": {reason}")).unwrap_or_default()),
        _ => match params.get("command") {
            Some(Value::String(command)) => format!("Run `{command}`"),
            Some(Value::Array(parts)) => format!("Run `{}`", parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")),
            _ => params.get("reason").and_then(Value::as_str).map(|reason| format!("Run a command: {reason}")).unwrap_or_else(|| "Run a command".into()),
        },
    };
    let thread_id = {
        let mut state = inner.state();
        state.approvals.insert(key.clone(), (id, kind));
        state.thread_id.clone().unwrap_or_default()
    };
    let _ = inner
        .out
        .send(Incoming::Request {
            id: RequestId::String(key),
            method: "session/request_permission".into(),
            params: Some(json!({
                "sessionId": thread_id,
                "title": title,
                "toolCall": { "toolCallId": params.get("itemId").or_else(|| params.get("callId")) },
                "options": [
                    { "optionId": "allow_once", "name": "Allow", "kind": "allow_once" },
                    { "optionId": "reject_once", "name": "Decline", "kind": "reject_once" }
                ]
            })),
        })
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_become_full_messages_and_tools_become_tool_calls() {
        let agent = item_updates(&json!({"type": "agentMessage", "id": "msg_1", "text": "Done."}), true);
        assert_eq!(agent[0]["sessionUpdate"], "agent_message");
        assert_eq!(agent[0]["messageId"], "msg_1");
        assert!(item_updates(&json!({"type": "agentMessage", "id": "msg_1", "text": ""}), false).is_empty(), "text streams as deltas until it completes");

        let started = item_updates(&json!({"type": "commandExecution", "id": "c1", "command": "pnpm test", "cwd": "/w", "status": "inProgress"}), false);
        assert_eq!(started[0]["sessionUpdate"], "tool_call");
        assert_eq!(started[0]["kind"], "execute");
        assert_eq!(started[0]["status"], "in_progress");
        assert!(started[0].get("rawOutput").is_none());
        let done = item_updates(&json!({"type": "commandExecution", "id": "c1", "command": "pnpm test", "status": "failed", "exitCode": 1, "aggregatedOutput": "1 failed"}), true);
        assert_eq!(done[0]["sessionUpdate"], "tool_call_update");
        assert_eq!(done[0]["status"], "failed");
        assert_eq!(done[0]["rawOutput"]["exitCode"], 1);
        let read = item_updates(&json!({"type": "commandExecution", "id": "c2", "command": "sed -n 1,40p a.rs", "status": "completed", "commandActions": [{"type": "read", "command": "sed -n 1,40p a.rs", "name": "a.rs", "path": "/w/a.rs"}]}), true);
        assert_eq!(read[0]["rawInput"]["actions"][0]["type"], "read", "Codex's own reading of the command reaches the transcript");

        let image = item_updates(&json!({"type": "imageGeneration", "id": "ig_1", "status": "completed", "result": "", "revisedPrompt": "a cat", "savedPath": "/w/out/cat.png", "failure": null}), true);
        assert_eq!(image[0]["rawOutput"]["savedPath"], "/w/out/cat.png");
        assert_eq!(image[0]["locations"][0]["path"], "/w/out/cat.png");

        let spawn = item_updates(&json!({"type": "collabAgentToolCall", "id": "k1", "tool": "spawnAgent", "status": "inProgress", "prompt": "7.3-pricing: price the tiers", "model": "gpt-6-luna", "receiverThreadIds": []}), false);
        assert_eq!(spawn[0]["name"], "collab:spawnAgent");
        assert_eq!(spawn[0]["title"], "7.3-pricing: price the tiers");
        assert_eq!(spawn[0]["rawInput"]["model"], "gpt-6-luna");
    }

    #[test]
    fn a_turn_that_ran_out_of_quota_reads_as_a_rate_limit() {
        assert_eq!(turn_outcome(&json!({"status": "completed"})).unwrap()["stopReason"], "end_turn");
        assert_eq!(turn_outcome(&json!({"status": "interrupted"})).unwrap()["stopReason"], "cancelled");
        let Err(TransportError::Remote(rpc)) = turn_outcome(&json!({"status": "failed", "error": {"message": "You've hit your usage limit", "codexErrorInfo": "usageLimitExceeded"}})) else {
            panic!("a failed turn is an error")
        };
        assert_eq!(rpc.data.unwrap()["errorKind"], "rate_limit");
        assert!(rpc.message.contains("usage limit"));
        let Err(TransportError::Remote(rpc)) = turn_outcome(&json!({"status": "failed", "error": {"message": "boom", "codexErrorInfo": {"httpConnectionFailed": {"httpStatusCode": 502}}}})) else {
            panic!()
        };
        assert_eq!(rpc.data.unwrap()["errorKind"], "httpConnectionFailed");
    }

    #[test]
    fn prompts_and_session_servers_are_said_in_codexs_words() {
        let input = user_input(Some(&json!([
            {"type": "text", "text": "fix it"},
            {"type": "image", "mimeType": "image/png", "data": "aGk="},
            {"type": "resource_link", "uri": "file:///w/src/main.rs", "name": "main.rs"}
        ])));
        assert_eq!(input[0], json!({"type": "text", "text": "fix it", "text_elements": []}));
        assert_eq!(input[1]["url"], "data:image/png;base64,aGk=");
        assert_eq!(input[2]["text"], "@/w/src/main.rs");

        let config = mcp_config(Some(&json!([{"name": "thingmaker", "command": "/bin/thingmaker-mcp", "args": ["--session", "s"], "env": [{"name": "TOKEN", "value": "t"}]}]))).unwrap();
        assert_eq!(config["mcp_servers.thingmaker"]["command"], "/bin/thingmaker-mcp");
        assert_eq!(config["mcp_servers.thingmaker"]["env"]["TOKEN"], "t");
        assert_eq!(mcp_config(Some(&json!([]))), None);
    }
}
