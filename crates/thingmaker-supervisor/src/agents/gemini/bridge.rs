//! Antigravity's `agy`, spoken to the session actor as ACP.
//!
//! `agy` in `stream-json` mode is one process per conversation that reads a
//! user event per line and writes events per line; it has no requests and no
//! responses. This bridge gives the actor the same surface as the other
//! providers (requests, notifications, a stream of [`Incoming`]) and
//! translates each way:
//!
//! | ACP (actor side) | `agy` |
//! | --- | --- |
//! | `initialize` | answered here: `agy` has no handshake |
//! | `session/new` / `session/load` | the `init` event the process writes at start; a load launches with `--conversation` |
//! | `session/set_config_option` | held here; a change relaunches `agy` with `--conversation` before the next turn |
//! | `session/prompt` → `stopReason` at turn end | a `user` event, then the turn's `result` |
//! | `session/cancel` | SIGINT, which ends the turn **and** the process; the next turn relaunches |
//! | `session/update` | `step_update` events: text deltas, tools, usage |
//!
//! There is no steering (input during a turn queues as the next turn), no
//! permission request (the mode decides; denials are reported after the
//! turn), and no quota signal.

use std::{
    collections::HashSet,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    sync::{mpsc, oneshot},
    time,
};

use super::launch::{GeminiLaunchOptions, arguments, mode_id};
use crate::{
    acp::PROTOCOL_VERSION,
    agents::PermissionStance,
    transport::{ExitInfo, Incoming, LaunchSpec, RequestId, RpcError, Transport, TransportError, jsonrpc, stdio::EVENT_LINE},
};

/// How long `agy` gets to write `init` after it starts.
const INIT_TIMEOUT: Duration = Duration::from_secs(60);

/// The settings a process was launched with.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Settings {
    model: Option<String>,
    effort: Option<String>,
    stance: PermissionStance,
}

struct State {
    /// `agy`'s conversation id, from `init`.
    conversation: Option<String>,
    /// What the next launch should use.
    wanted: Settings,
    /// What the running process was launched with.
    applied: Settings,
    /// The model `init` named, for a session that chose none.
    reported_model: Option<String>,
    /// `agy models`, as `(slug, name)`.
    models: Vec<(String, String)>,
    /// Bumped on every launch; events from an older process are dropped.
    epoch: u64,
    /// Whether a process is running that can take a turn.
    alive: bool,
    pending_turn: Option<oneshot::Sender<Result<Value, TransportError>>>,
    pending_init: Option<oneshot::Sender<String>>,
    /// Set by a cancel: the process is about to exit on purpose.
    cancelling: bool,
    /// The prompt in flight, echoed as the user message when `agy` takes it.
    prompt_text: Option<String>,
    /// Tool steps already announced.
    tools: HashSet<String>,
    agent_version: String,
}

struct Inner {
    out: mpsc::Sender<Incoming>,
    /// The program, working directory and environment of every launch, and
    /// the arguments that come before `agy`'s own (a test's mock script).
    base: LaunchSpec,
    prefix: Vec<String>,
    generation: u64,
    state: Mutex<State>,
    process: Mutex<Option<Transport>>,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn process(&self) -> Option<Transport> {
        self.process.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
}

/// A live Antigravity attachment, addressed like a [`Transport`].
#[derive(Clone)]
pub struct GeminiBridge {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for GeminiBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GeminiBridge").field("pid", &self.pid()).finish()
    }
}

fn remote(code: i64, message: &str) -> TransportError {
    TransportError::Remote(RpcError { code, message: message.to_string(), data: None })
}

impl GeminiBridge {
    /// Starts `agy` with the launch's own arguments and the translation task.
    pub async fn spawn(spec: LaunchSpec, generation: u64, launch: GeminiLaunchOptions) -> Result<(GeminiBridge, mpsc::Receiver<Incoming>), TransportError> {
        let own = launch.arguments();
        let prefix = spec.args[..spec.args.len().saturating_sub(own.len())].to_vec();
        let settings = Settings { model: launch.model.clone(), effort: launch.effort.clone(), stance: launch.permission_mode };
        let (out, out_rx) = mpsc::channel(1024);
        let inner = Arc::new(Inner {
            out,
            base: spec.clone(),
            prefix,
            generation,
            state: Mutex::new(State {
                conversation: None,
                wanted: settings.clone(),
                applied: settings,
                reported_model: None,
                models: Vec::new(),
                epoch: 0,
                alive: false,
                pending_turn: None,
                pending_init: None,
                cancelling: false,
                prompt_text: None,
                tools: HashSet::new(),
                agent_version: String::new(),
            }),
            process: Mutex::new(None),
        });
        let bridge = GeminiBridge { inner };
        bridge.start(spec.args).await?;
        Ok((bridge, out_rx))
    }

    /// Launches a process with `args` and starts reading it.
    async fn start(&self, args: Vec<String>) -> Result<(), TransportError> {
        let mut spec = self.inner.base.clone();
        spec.args = args;
        let (transport, incoming) = Transport::spawn_events(spec, self.inner.generation).await?;
        let epoch = {
            let mut state = self.inner.state();
            state.epoch += 1;
            state.alive = true;
            state.cancelling = false;
            state.epoch
        };
        *self.inner.process.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(transport);
        tokio::spawn(pump(Arc::clone(&self.inner), epoch, incoming));
        Ok(())
    }

    /// Replaces the process with one launched with the wanted settings on the
    /// same conversation, and waits for it to say it is ready.
    async fn relaunch(&self) -> Result<(), TransportError> {
        let (args, wanted) = {
            let mut state = self.inner.state();
            // Anything the old process still says is about to be stale.
            state.epoch += 1;
            let wanted = state.wanted.clone();
            let mut args = self.inner.prefix.clone();
            args.extend(arguments(wanted.model.as_deref(), wanted.effort.as_deref(), wanted.stance, state.conversation.as_deref()));
            (args, wanted)
        };
        let old = self.inner.process.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(old) = old {
            let _ = old.shutdown(Duration::from_secs(5)).await;
        }
        let (tx, rx) = oneshot::channel();
        self.inner.state().pending_init = Some(tx);
        self.start(args).await?;
        match time::timeout(INIT_TIMEOUT, rx).await {
            Ok(Ok(_)) => {
                self.inner.state().applied = wanted;
                Ok(())
            }
            _ => Err(TransportError::Timeout { method: "agy relaunch".into(), timeout_ms: INIT_TIMEOUT.as_millis() as u64 }),
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner.process().and_then(|process| process.pid())
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, TransportError> {
        self.request_observed(method, params, timeout, None).await
    }

    pub async fn request_observed(&self, method: &str, params: Value, timeout: Duration, written: Option<oneshot::Sender<()>>) -> Result<Value, TransportError> {
        match method {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "agentInfo": { "name": "antigravity-cli", "title": "Antigravity", "version": self.inner.state().agent_version },
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": { "image": false, "embeddedContext": true },
                    "mcpCapabilities": { "http": false }
                },
                "authMethods": [],
                "_meta": { "steering": { "supported": false } }
            })),
            "session/new" | "session/load" => self.open(method == "session/load", &params, timeout).await,
            "session/set_config_option" => {
                let id = params.get("configId").and_then(Value::as_str).unwrap_or_default();
                let value = params.get("value").and_then(Value::as_str).map(str::to_string);
                {
                    let mut state = self.inner.state();
                    match id {
                        "model" => state.wanted.model = value.filter(|model| !model.is_empty() && model != "default"),
                        "effort" => state.wanted.effort = value.filter(|effort| !effort.is_empty() && effort != "default"),
                        "mode" => {
                            state.wanted.stance = match value.as_deref() {
                                Some("accept-edits") => PermissionStance::AcceptEdits,
                                _ => PermissionStance::ReadOnly,
                            }
                        }
                        other => return Err(remote(jsonrpc::INVALID_PARAMS, &format!("Antigravity has no option {other}"))),
                    }
                }
                Ok(json!({ "configOptions": self.config_options() }))
            }
            "session/prompt" => self.prompt(&params, timeout, written).await,
            crate::acp::capabilities::STEER_METHOD => Err(remote(jsonrpc::METHOD_NOT_FOUND, "Antigravity does not take input during a turn")),
            "session/close" => Ok(json!({})),
            other => Err(remote(jsonrpc::METHOD_NOT_FOUND, &format!("Antigravity bridge does not implement {other}"))),
        }
    }

    async fn open(&self, resume: bool, params: &Value, timeout: Duration) -> Result<Value, TransportError> {
        // The process was started with the launch; it names its conversation
        // in `init` without waiting for a prompt.
        let rx = {
            let mut state = self.inner.state();
            if state.conversation.is_some() {
                None
            } else {
                let (tx, rx) = oneshot::channel();
                state.pending_init = Some(tx);
                Some(rx)
            }
        };
        let program = self.inner.base.program.clone();
        let env = self.inner.base.env.clone();
        let models = tokio::task::spawn_blocking(move || super::probe::read_models_with(&program, &env, Duration::from_secs(20)));
        if let Some(rx) = rx {
            match time::timeout(timeout.max(INIT_TIMEOUT), rx).await {
                Ok(Ok(_)) => {}
                _ => return Err(remote(jsonrpc::INTERNAL_ERROR, "Antigravity did not start a conversation")),
            }
        }
        let conversation = self.inner.state().conversation.clone().unwrap_or_default();
        if resume {
            let asked = params.get("sessionId").and_then(Value::as_str).unwrap_or_default();
            // `agy` starts a fresh conversation, with only a warning, when the
            // one asked for does not exist.
            if !asked.is_empty() && asked != conversation {
                return Err(remote(jsonrpc::INVALID_PARAMS, &format!("Resource not found: Antigravity has no conversation {asked}")));
            }
        }
        if let Ok(Ok(list)) = models.await {
            self.inner.state().models = list.into_iter().map(|model| (model.id, model.name)).collect();
        }
        Ok(json!({ "sessionId": conversation, "configOptions": self.config_options() }))
    }

    async fn prompt(&self, params: &Value, timeout: Duration, written: Option<oneshot::Sender<()>>) -> Result<Value, TransportError> {
        let (relaunch, conversation) = {
            let state = self.inner.state();
            (!state.alive || state.wanted != state.applied, state.conversation.clone())
        };
        if conversation.is_none() {
            return Err(remote(jsonrpc::INVALID_PARAMS, "no Antigravity conversation is open"));
        }
        if relaunch {
            self.relaunch().await?;
        }
        let text = prompt_text(params.get("prompt"));
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.inner.state();
            state.pending_turn = Some(tx);
            state.prompt_text = Some(text.clone());
        }
        let process = self.inner.process().ok_or(TransportError::NotRunning)?;
        if let Err(error) = process.write_line(&json!({ "event": "user", "message": { "content": text } })).await {
            self.inner.state().pending_turn = None;
            return Err(error);
        }
        if let Some(written) = written {
            let _ = written.send(());
        }
        match time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err(TransportError::NotRunning),
            Err(_) => Err(TransportError::Timeout { method: "session/prompt".into(), timeout_ms: timeout.as_millis() as u64 }),
        }
    }

    /// The config options the actor reads the model, effort and mode from.
    fn config_options(&self) -> Value {
        let state = self.inner.state();
        let current_model = state.wanted.model.clone().or_else(|| state.reported_model.clone());
        let mut models: Vec<Value> = state.models.iter().map(|(id, name)| json!({ "value": id, "name": name })).collect();
        if let Some(current) = &current_model
            && !state.models.iter().any(|(id, _)| id == current)
        {
            models.insert(0, json!({ "value": current, "name": current }));
        }
        let efforts: Vec<Value> = ["low", "medium", "high", "max"].iter().map(|effort| json!({ "value": effort, "name": capitalise(effort) })).collect();
        json!([
            { "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": mode_id(state.wanted.stance),
              "options": [ { "value": "accept-edits", "name": "Edit and run commands" }, { "value": "plan", "name": "Plan only" } ] },
            { "id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": state.wanted.effort, "options": efforts },
            { "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": current_model, "options": models }
        ])
    }

    /// `session/cancel`: SIGINT ends the turn and the process with it; the
    /// next turn relaunches on the same conversation.
    pub async fn notify(&self, method: &str, _params: Value) -> Result<(), TransportError> {
        if method != "session/cancel" {
            return Ok(());
        }
        let pid = {
            let mut state = self.inner.state();
            if state.pending_turn.is_none() {
                return Ok(());
            }
            state.cancelling = true;
            // SIGINT takes the process with the turn: whatever comes next
            // starts a new one, even if this one has not finished exiting.
            state.alive = false;
            self.pid()
        };
        #[cfg(unix)]
        if let Some(pid) = pid {
            // SAFETY: a plain signal to the child this bridge started.
            unsafe {
                libc::kill(pid as i32, libc::SIGINT);
            }
        }
        #[cfg(not(unix))]
        let _ = pid;
        Ok(())
    }

    /// `agy` asks for nothing; the mode answers in advance.
    pub async fn respond(&self, _id: &RequestId, _result: Value) -> Result<(), TransportError> {
        Ok(())
    }

    pub async fn respond_error(&self, _id: &RequestId, _code: i64, _message: &str) -> Result<(), TransportError> {
        Ok(())
    }

    pub async fn shutdown(&self, budget: Duration) -> ExitInfo {
        {
            let mut state = self.inner.state();
            state.alive = false;
        }
        match self.inner.process() {
            Some(process) => process.shutdown(budget).await,
            None => ExitInfo { status: None, signal: None, forced: false },
        }
    }
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// ACP prompt blocks as the one string `agy` takes: text as it is, a file
/// mention's content inline, a link by its path.
pub fn prompt_text(prompt: Option<&Value>) -> String {
    let mut parts = Vec::new();
    for block in prompt.and_then(Value::as_array).into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => parts.push(block.get("text").and_then(Value::as_str).unwrap_or_default().to_string()),
            Some("resource") => {
                let resource = block.get("resource").unwrap_or(&Value::Null);
                let uri = resource.get("uri").and_then(Value::as_str).unwrap_or("file");
                if let Some(text) = resource.get("text").and_then(Value::as_str) {
                    parts.push(format!("{uri}:\n```\n{text}\n```"));
                }
            }
            Some("resource_link") => {
                if let Some(uri) = block.get("uri").and_then(Value::as_str) {
                    parts.push(format!("@{}", uri.trim_start_matches("file://")));
                }
            }
            _ => {}
        }
    }
    parts.join("\n\n")
}

async fn send_update(inner: &Inner, conversation: &str, update: Value) {
    let _ = inner
        .out
        .send(Incoming::Notification { method: "session/update".into(), params: Some(json!({ "sessionId": conversation, "update": update })) })
        .await;
}

async fn pump(inner: Arc<Inner>, epoch: u64, mut incoming: mpsc::Receiver<Incoming>) {
    while let Some(message) = incoming.recv().await {
        let current = inner.state().epoch == epoch;
        match message {
            Incoming::Notification { method, params } if method == EVENT_LINE => {
                if current {
                    on_event(&inner, params.unwrap_or(Value::Null)).await;
                }
            }
            Incoming::Exited(info) => {
                if !current {
                    // A process replaced on purpose.
                    continue;
                }
                let (pending, cancelling) = {
                    let mut state = inner.state();
                    state.alive = false;
                    (state.pending_turn.take(), std::mem::take(&mut state.cancelling))
                };
                if cancelling {
                    // The cancel's own exit: the turn is over and the next one
                    // relaunches. The actor never sees this process go.
                    if let Some(pending) = pending {
                        let _ = pending.send(Ok(json!({ "stopReason": "cancelled" })));
                    }
                    continue;
                }
                if let Some(pending) = pending {
                    let _ = pending.send(Err(TransportError::Exited(info.clone())));
                }
                let _ = inner.out.send(Incoming::Exited(info)).await;
            }
            Incoming::StderrLine(line) => {
                if current {
                    let _ = inner.out.send(Incoming::StderrLine(line)).await;
                }
            }
            other => {
                if current {
                    let _ = inner.out.send(other).await;
                }
            }
        }
    }
}

fn tool_title(name: &str, parameters: &Value) -> String {
    let param = |key: &str| parameters.get(key).and_then(Value::as_str).map(str::to_string);
    match name {
        "run_command" => param("CommandLine").map(|command| format!("Run `{command}`")).unwrap_or_else(|| "Run a command".into()),
        "write_to_file" => param("TargetFile").map(|file| format!("Write {file}")).unwrap_or_else(|| "Write a file".into()),
        "replace_file_content" | "multi_replace_file_content" | "edit_file" => {
            param("TargetFile").map(|file| format!("Edit {file}")).unwrap_or_else(|| "Edit a file".into())
        }
        "view_file" | "read_file" => param("AbsolutePath").or_else(|| param("TargetFile")).map(|file| format!("Read {file}")).unwrap_or_else(|| "Read a file".into()),
        _ => {
            let first = parameters.as_object().and_then(|object| object.values().find_map(Value::as_str)).map(|value| value.chars().take(80).collect::<String>());
            match first {
                Some(value) => format!("{name} {value}"),
                None => name.to_string(),
            }
        }
    }
}

fn tool_kind(name: &str) -> &'static str {
    match name {
        "run_command" | "send_command_input" => "execute",
        name if name.contains("write") || name.contains("replace") || name.contains("edit") => "edit",
        name if name.contains("search") || name.contains("grep") || name.contains("find") => "search",
        name if name.contains("view") || name.contains("read") || name.contains("list") => "read",
        name if name.starts_with("browser") || name.contains("url") || name.contains("web") => "fetch",
        _ => "other",
    }
}

/// Whether a failed turn was the account's limit, in Antigravity's words.
fn looks_like_limit(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["quota", "rate limit", "rate_limit", "resource_exhausted", "resource exhausted", "usage limit", "limit reached", "exceeded"].iter().any(|needle| lower.contains(needle))
}

async fn on_event(inner: &Arc<Inner>, event: Value) {
    match event.get("event").and_then(Value::as_str) {
        Some("init") => {
            let id = event.get("conversation_id").and_then(Value::as_str).unwrap_or_default().to_string();
            let pending = {
                let mut state = inner.state();
                state.conversation = Some(id.clone());
                state.reported_model = event.get("init").and_then(|init| init.get("model")).and_then(Value::as_str).map(str::to_string);
                state.pending_init.take()
            };
            if let Some(pending) = pending {
                let _ = pending.send(id);
            }
        }
        Some("step_update") => {
            let step = event.get("step_update").cloned().unwrap_or(Value::Null);
            let conversation = inner.state().conversation.clone().unwrap_or_default();
            let index = step.get("step_index").and_then(Value::as_u64).unwrap_or(0);
            let id = format!("{conversation}-{index}");
            let state_name = step.get("state").and_then(Value::as_str).unwrap_or_default();
            match step.get("step_type").and_then(Value::as_str) {
                Some("user_input") if state_name == "DONE" => {
                    let text = inner.state().prompt_text.take();
                    if let Some(text) = text.filter(|text| !text.is_empty()) {
                        send_update(inner, &conversation, json!({ "sessionUpdate": "user_message", "messageId": id, "content": [{ "type": "text", "text": text }] })).await;
                    }
                }
                Some("agent_response") => {
                    if let Some(delta) = step.get("text_delta").and_then(Value::as_str).filter(|delta| !delta.is_empty()) {
                        send_update(inner, &conversation, json!({ "sessionUpdate": "agent_message_chunk", "messageId": id, "content": { "type": "text", "text": delta } })).await;
                    }
                    if let Some(usage) = step.get("usage") {
                        let used = usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0) + usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
                        if used > 0 {
                            send_update(inner, &conversation, json!({ "sessionUpdate": "usage_update", "used": used })).await;
                        }
                    }
                }
                Some("tool") => {
                    let info = step.get("tool_info").cloned().unwrap_or(Value::Null);
                    let name = info.get("name").and_then(Value::as_str).or_else(|| step.get("tool_name").and_then(Value::as_str)).unwrap_or("tool").to_string();
                    let parameters = info.get("parameters").cloned().unwrap_or(Value::Null);
                    let first = inner.state().tools.insert(id.clone());
                    if first {
                        send_update(
                            inner,
                            &conversation,
                            json!({ "sessionUpdate": "tool_call", "toolCallId": id, "title": tool_title(&name, &parameters), "kind": tool_kind(&name), "status": "in_progress", "rawInput": parameters }),
                        )
                        .await;
                    }
                    match state_name {
                        "DONE" => {
                            let mut patch = json!({ "sessionUpdate": "tool_call_update", "toolCallId": id, "status": "completed" });
                            if let Some(output) = info.get("output") {
                                patch["rawOutput"] = output.clone();
                            }
                            send_update(inner, &conversation, patch).await;
                        }
                        "ERROR" => {
                            let message = info.get("error").and_then(|error| error.get("message")).and_then(Value::as_str).unwrap_or("the tool failed");
                            send_update(
                                inner,
                                &conversation,
                                json!({ "sessionUpdate": "tool_call_update", "toolCallId": id, "status": "failed",
                                        "content": [{ "type": "content", "content": { "type": "text", "text": message } }] }),
                            )
                            .await;
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        Some("result") => {
            let result = event.get("result").cloned().unwrap_or(Value::Null);
            let denied: Vec<String> = result
                .get("denied_actions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|action| action.get("display_name").or_else(|| action.get("action")).and_then(Value::as_str).map(str::to_string))
                .collect();
            if !denied.is_empty() {
                let line = format!("Antigravity refused {} under this workspace's trust", denied.join(", "));
                let _ = inner.out.send(Incoming::StderrLine(line.into_bytes())).await;
            }
            let (pending, cancelling) = {
                let mut state = inner.state();
                state.prompt_text = None;
                (state.pending_turn.take(), state.cancelling)
            };
            let Some(pending) = pending else { return };
            let outcome = match result.get("status").and_then(Value::as_str) {
                Some("SUCCESS") => Ok(json!({ "stopReason": "end_turn" })),
                _ if cancelling => Ok(json!({ "stopReason": "cancelled" })),
                _ => {
                    let message = result
                        .get("error")
                        .and_then(|error| error.get("message").and_then(Value::as_str).or_else(|| error.as_str()))
                        .map(str::to_string)
                        .unwrap_or_else(|| "Antigravity ended the turn with an error".into());
                    let kind = if looks_like_limit(&message) { "rate_limit" } else { "other" };
                    Err(TransportError::Remote(RpcError { code: jsonrpc::INTERNAL_ERROR, message: format!("Internal error: {message}"), data: Some(json!({ "errorKind": kind })) }))
                }
            };
            let _ = pending.send(outcome);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompt_becomes_the_one_string_agy_takes() {
        let text = prompt_text(Some(&json!([
            { "type": "resource", "resource": { "uri": "file:///w/a.rs", "text": "fn main() {}" } },
            { "type": "text", "text": "Explain this." },
            { "type": "resource_link", "uri": "file:///w/b.rs", "name": "b.rs" },
            { "type": "image", "data": "…" }
        ])));
        assert_eq!(text, "file:///w/a.rs:\n```\nfn main() {}\n```\n\nExplain this.\n\n@/w/b.rs");
    }

    #[test]
    fn tools_read_as_what_they_do() {
        assert_eq!(tool_title("run_command", &json!({ "CommandLine": "ls" })), "Run `ls`");
        assert_eq!(tool_title("write_to_file", &json!({ "TargetFile": "/w/hello.txt" })), "Write /w/hello.txt");
        assert_eq!(tool_title("browser_get_dom", &json!({})), "browser_get_dom");
        assert_eq!(tool_kind("run_command"), "execute");
        assert_eq!(tool_kind("write_to_file"), "edit");
        assert_eq!(tool_kind("browser_click_element"), "fetch");
        assert!(looks_like_limit("RESOURCE_EXHAUSTED: quota exceeded for this account"));
        assert!(!looks_like_limit("the tests failed"));
    }
}
