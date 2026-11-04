//! Nested forks reporting back to the session they were copied from.
//!
//! A fork's final answer at the end of each turn is held for its parent
//! (`Engine::report_to_parent`), and whatever is held rides in front of the
//! parent's next message as context. Nothing is steered into a running turn
//! and no turn is started for it: the parent knows where its forks stand
//! without being set to work by them.

use serde::Deserialize;
use serde_json::json;
use tauri::State;
use thingmaker_supervisor::{
    DesktopError,
    acp::updates::{ContentBlock, SessionUpdate},
    storage::forks::{NestedReport, reports_prompt},
    supervisor::{SessionActor, SessionEvent, TurnEffect, TurnPhase},
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

/// Follows a session's turns and, while it is a nested fork, passes its final
/// answer on to its parent when a turn ends well. Cheap for any other
/// session: one lookup when a turn ends.
pub fn watch_nested(state: &AppState, actor: &SessionActor) {
    let Some(engine) = state.engine.get().cloned() else { return };
    let actor = actor.clone();
    let mut subscription = actor.subscribe();
    tauri::async_runtime::spawn(async move {
        // The turn's agent messages, in order: the last one with words is
        // its final answer.
        let mut messages: Vec<(String, String)> = Vec::new();
        while let Some(event) = subscription.recv().await {
            match &event.payload {
                SessionEvent::Update(SessionUpdate::AgentMessage(message)) => {
                    let text: String = message.content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }).collect();
                    match messages.iter_mut().find(|(id, _)| *id == message.message_id) {
                        Some((_, existing)) if message.replace => *existing = text,
                        Some((_, existing)) => existing.push_str(&text),
                        None => messages.push((message.message_id.clone(), text)),
                    }
                }
                SessionEvent::Turn(TurnEffect::Settled { phase, .. }) => {
                    let answer = messages.iter().rev().map(|(_, text)| text.trim()).find(|text| !text.is_empty()).map(str::to_string);
                    messages.clear();
                    let (TurnPhase::Succeeded, Some(answer)) = (phase, answer) else { continue };
                    let agent_session_id = actor.snapshot().await.ok().and_then(|snapshot| snapshot.agent_session_id);
                    if let Some(agent_session_id) = agent_session_id
                        && let Err(reason) = engine.report_to_parent(&agent_session_id, &answer)
                    {
                        tracing::trace!(%reason, "turn not reported to a parent");
                    }
                }
                SessionEvent::Exited(_) => break,
                _ => {}
            }
        }
    });
}

/// What this session's nested forks reported since its last message, put in
/// front of the message being sent, and so taken.
pub fn reports_first(state: &AppState, handle: &str, blocks: &mut Vec<serde_json::Value>) {
    let agent_session_id = state.agent_session_id(handle);
    let Ok(Some(row)) = state.with_storage(|storage| storage.session_by_agent_id_anywhere(&agent_session_id)) else { return };
    let Ok(reports) = state.with_storage(|storage| storage.nested_reports_take(&row.id)) else { return };
    if reports.is_empty() {
        return;
    }
    blocks.insert(0, json!({ "type": "text", "text": reports_prompt(&reports) }));
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedRequest {
    pub workspace_id: String,
    pub agent_session_id: String,
}

fn row(state: &AppState, request: &NestedRequest) -> CommandResult<thingmaker_supervisor::storage::workspaces::SessionRecord> {
    state
        .with_storage(|storage| storage.session_by_agent_id(&request.workspace_id, &request.agent_session_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("that session is not in this workspace's list"))
}

/// The reports waiting for this session's next message.
#[tauri::command]
pub fn session_nested_reports(request: NestedRequest, state: State<'_, AppState>) -> CommandResult<Vec<NestedReport>> {
    let row = row(&state, &request)?;
    state.with_storage(|storage| storage.nested_reports(&row.id)).map_err(storage_error)
}

/// Whether this fork passes its answers on to its parent.
#[tauri::command]
pub fn session_reporting(request: NestedRequest, state: State<'_, AppState>) -> CommandResult<bool> {
    let row = row(&state, &request)?;
    state.with_storage(|storage| storage.nested_reporting(&row.id)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetReportingRequest {
    #[serde(flatten)]
    pub session: NestedRequest,
    pub on: bool,
}

#[tauri::command]
pub fn session_set_reporting(request: SetReportingRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let row = row(&state, &request.session)?;
    state.with_storage(|storage| storage.nested_set_reporting(&row.id, request.on)).map_err(storage_error)
}
