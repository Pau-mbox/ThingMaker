//! The ThingMaker MCP server's protocol: `initialize`, `tools/list` and
//! `tools/call`, answered from the [`Delegation`] service for one
//! orchestrator session.
//!
//! The same tools serve every provider: Claude Code and Codex both start the
//! server from the session's own MCP configuration (never the user's files)
//! and speak MCP to it over stdio; the stdio child only relays to this code
//! (see `socket`).

use std::time::Duration;

use serde_json::{Value, json};

use super::jobs::{Caller, DEFAULT_AWAIT, DelegateArgs, Delegation, JobView, MAX_AWAIT};

pub const SERVER_NAME: &str = "team";
const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// What the server tells a client about itself in `initialize`. Claude Code
/// and Codex both put these instructions in front of the model.
pub const INSTRUCTIONS: &str = "ThingMaker runs a team for this session: workers on other providers and models, chosen by the user. \
Use `list_workers` to see the team (it can change during the session), `delegate` to hand a worker a self-contained task (it answers with a job id at once), \
and `await_jobs` to wait for reports. Delegate independent tasks together, then await them. Workers share the workspace but not your conversation. \
Check a worker's result before you rely on it.";

/// What a worker's reduced server says about itself.
pub const WORKER_INSTRUCTIONS: &str = "ThingMaker gives this worker the project's shared memory and its run's task board. \
Read the memory before deciding something the project may already have decided, and write down decisions, conventions and facts the rest of the team will need.";

fn tools() -> Value {
    json!([
        {
            "name": "list_workers",
            "title": "List the team",
            "description": "The workers this session may delegate to right now: name, provider, model, capabilities (code, image, fast, review, research, ui, …), a note on when to use each, and whether its account has quota left. The user can change the team at any time, so check before planning.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "delegate",
            "title": "Delegate a task",
            "description": "Hands a task to a worker and returns a job id immediately; the worker runs in the background in this workspace. Name a worker, or ask for a capability (for example `image` for image generation) and the team server picks the worker with the most quota left. The worker does not see this conversation: write the task so it stands alone (goal, constraints, where to write output, what to report). Use `continue_job` to send a follow-up to the worker of a finished job, keeping its context.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": "The complete task, self-contained." },
                    "worker": { "type": "string", "description": "A worker's name from list_workers." },
                    "capability": { "type": "string", "description": "What the task needs, when no worker is named: code, image, fast, review, research, ui." },
                    "files": { "type": "array", "items": { "type": "string" }, "description": "Paths the worker should start from." },
                    "continue_job": { "type": "string", "description": "A finished job whose worker should take this as a follow-up." }
                },
                "required": ["task"],
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true }
        },
        {
            "name": "await_jobs",
            "title": "Wait for jobs",
            "description": "Waits until the given jobs finish (or any one of them, with mode `any`), up to timeout_seconds, and returns each job's status and, for finished ones, the worker's report. With no job_ids, waits for every unfinished job. If the timeout passes first, the jobs are still running: call again. A job with status `waiting` hit a temporary limit (an image generation limit, an account window) and retries by itself at `retries_at`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "job_ids": { "type": "array", "items": { "type": "string" } },
                    "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": MAX_AWAIT.as_secs(), "description": "Default 300." },
                    "mode": { "type": "string", "enum": ["all", "any"] }
                },
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "job_status",
            "title": "Check a job",
            "description": "One job's status now, without waiting, and its report when it has finished.",
            "inputSchema": {
                "type": "object",
                "properties": { "job_id": { "type": "string" } },
                "required": ["job_id"],
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "cancel_job",
            "title": "Cancel a job",
            "description": "Stops a running job; its worker's turn is interrupted. Whatever it already wrote stays in the workspace.",
            "inputSchema": {
                "type": "object",
                "properties": { "job_id": { "type": "string" } },
                "required": ["job_id"],
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false }
        }
    ])
}

/// A job as the model reads it: what matters for the next decision.
pub fn job_for_model(job: &JobView) -> Value {
    let mut value = json!({
        "job_id": job.id,
        "worker": job.worker,
        "provider": job.provider.as_str(),
        "status": job.status,
    });
    if let Some(model) = &job.model {
        value["model"] = json!(model);
    }
    if let Some(from) = &job.rerouted_from {
        value["rerouted_from"] = json!(from);
    }
    if let Some(previous) = &job.continues {
        value["continues"] = json!(previous);
    }
    if let Some(result) = &job.result {
        value["report"] = json!(result);
    }
    if let Some(error) = &job.error {
        value["error"] = json!(error);
    }
    if job.attempts > 0 {
        value["retries"] = json!(job.attempts);
    }
    if let (Some(reason), Some(at)) = (&job.waiting_reason, job.retry_at_unix_ms) {
        value["waiting_for"] = json!(reason);
        value["retries_at"] = json!(super::combo::format_reset(at / 1000));
        value["retries_in_seconds"] = json!(at.saturating_sub(super::jobs::now_unix_ms()) / 1000);
    }
    if !job.status.is_finished() {
        let elapsed = super::jobs::now_unix_ms().saturating_sub(job.started_at_unix_ms) / 1000;
        value["running_for_seconds"] = json!(elapsed);
        value["tool_calls"] = json!(job.tool_calls);
    }
    value
}

pub fn text_result(value: &Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    json!({ "content": [{ "type": "text", "text": text }], "structuredContent": value, "isError": is_error })
}

pub fn error_result(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn call_tool(delegation: &Delegation, session: &str, name: &str, arguments: &Value) -> Value {
    let string = |key: &str| arguments.get(key).and_then(Value::as_str).map(str::to_string);
    match name {
        "list_workers" => match delegation.list_workers(session) {
            Ok(value) => text_result(&value, false),
            Err(error) => error_result(&error),
        },
        "delegate" => {
            let args: DelegateArgs = match serde_json::from_value(arguments.clone()) {
                Ok(args) => args,
                Err(error) => return error_result(&format!("delegate: {error}")),
            };
            match delegation.delegate(session, args) {
                Ok(job) => text_result(&job_for_model(&job), false),
                Err(error) => error_result(&error),
            }
        }
        "await_jobs" => {
            let ids: Vec<String> = arguments
                .get("job_ids")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let timeout = arguments.get("timeout_seconds").and_then(Value::as_u64).map(Duration::from_secs).unwrap_or(DEFAULT_AWAIT);
            let any = string("mode").as_deref() == Some("any");
            match delegation.await_jobs(session, &ids, timeout, any).await {
                Ok(jobs) => {
                    let pending = jobs.iter().filter(|job| !job.status.is_finished()).count();
                    let waiting = jobs.iter().filter(|job| job.status == super::jobs::JobStatus::Waiting).count();
                    let mut value = json!({ "jobs": jobs.iter().map(job_for_model).collect::<Vec<_>>() });
                    if waiting > 0 {
                        value["note"] = json!(format!(
                            "{pending} not finished, {waiting} of them waiting out a temporary limit; they retry by themselves at retries_at. Carry on with other work and await them again later, or cancel them."
                        ));
                    } else if pending > 0 {
                        value["note"] = json!(format!("{pending} still running; call await_jobs again to keep waiting."));
                    }
                    text_result(&value, false)
                }
                Err(error) => error_result(&error),
            }
        }
        "job_status" => match string("job_id").map(|id| delegation.job(session, &id)) {
            Some(Ok(job)) => text_result(&job_for_model(&job), false),
            Some(Err(error)) => error_result(&error),
            None => error_result("job_status needs a job_id"),
        },
        "cancel_job" => match string("job_id") {
            Some(id) => match delegation.cancel(session, &id).await {
                Ok(job) => text_result(&job_for_model(&job), false),
                Err(error) => error_result(&error),
            },
            None => error_result("cancel_job needs a job_id"),
        },
        other => error_result(&format!("The team server has no tool {other:?}")),
    }
}

/// Every tool this caller may use: the team's own (orchestrators only), then
/// the extension's.
fn tools_for(delegation: &Delegation, caller: &Caller) -> Value {
    let mut list: Vec<Value> = match caller {
        Caller::Orchestrator { .. } => tools().as_array().cloned().unwrap_or_default(),
        Caller::Worker { .. } => Vec::new(),
    };
    if let Some(extension) = delegation.extension() {
        list.extend(extension.tools(caller));
    }
    Value::Array(list)
}

/// Answers one JSON-RPC message from the client; `None` for notifications
/// and for responses to requests this server never makes.
pub async fn handle(delegation: &Delegation, caller: &Caller, message: &Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str)?;
    let id = message.get("id").cloned()?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
            let version = PROTOCOL_VERSIONS.iter().find(|known| **known == asked).copied().unwrap_or(PROTOCOL_VERSIONS[1]);
            let mut instructions = match caller {
                Caller::Orchestrator { .. } => INSTRUCTIONS.to_string(),
                Caller::Worker { .. } => WORKER_INSTRUCTIONS.to_string(),
            };
            if let Some(extra) = delegation.extension().and_then(|extension| extension.instructions(caller)) {
                instructions.push(' ');
                instructions.push_str(&extra);
            }
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "title": "Team (ThingMaker)", "version": env!("CARGO_PKG_VERSION") },
                "instructions": instructions,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools_for(delegation, caller) }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match delegation.extension().and_then(|extension| extension.call(caller, name, &arguments)) {
                Some(answer) => answer.await,
                None => match caller {
                    Caller::Orchestrator { session, .. } => call_tool(delegation, session, name, &arguments).await,
                    Caller::Worker { .. } => error_result(&format!("A worker's team server has no tool {name:?}")),
                },
            }
        }
        "resources/list" => json!({ "resources": [] }),
        "prompts/list" => json!({ "prompts": [] }),
        other => return Some(rpc_error(&id, -32601, &format!("method not found: {other}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_has_an_object_schema_and_the_names_the_guidance_uses() {
        let tools = tools();
        let names: Vec<&str> = tools.as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_workers", "delegate", "await_jobs", "job_status", "cancel_job"]);
        for tool in tools.as_array().unwrap() {
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
        for name in ["list_workers", "delegate", "await_jobs"] {
            assert!(INSTRUCTIONS.contains(name));
        }
    }
}
