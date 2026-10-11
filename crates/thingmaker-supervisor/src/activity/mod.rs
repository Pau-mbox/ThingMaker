//! Derived, read-only activity for Chill. No provider calls and no file contents.
pub mod extract;
use crate::{
    acp::updates::{SessionUpdate, ToolPatch},
    agents::{
        Provider,
        events::{RuntimeEvent, SubagentStatus},
    },
    storage::{Storage, now_unix_ms},
    supervisor::{EventEnvelope, SessionActor, SessionEvent, TurnEffect},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActivity {
    pub id: String,
    pub workspace_id: String,
    pub path: String,
    pub external: bool,
    pub operation: String,
    pub touched_at: i64,
    pub session_id: String,
    #[serde(default)]
    pub active_actors: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityActor {
    pub id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub provider: Provider,
    pub model: Option<String>,
    pub status: String,
    pub task: String,
    pub operation: String,
    pub file_id: Option<String>,
    pub last_seen: i64,
    pub waiting_reason: Option<String>,
    pub retry_at_unix_ms: Option<i64>,
    pub native: bool,
    pub generation: crate::ids::DecimalId,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub revision: String,
    pub observed_at: i64,
    pub actors: Vec<ActivityActor>,
    pub files: Vec<FileActivity>,
}
#[derive(Default)]
struct State {
    revision: u64,
    actors: BTreeMap<String, ActivityActor>,
    files: BTreeMap<String, FileActivity>,
    tools: HashMap<String, ToolPatch>,
    confirmed: BTreeMap<String, u64>,
    cursors: HashMap<String, u64>,
    roots: HashMap<String, PathBuf>,
    sources: HashMap<String, String>,
}
pub struct ActivityService {
    state: Mutex<State>,
    storage: Arc<Mutex<Storage>>,
    observers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}
impl ActivityService {
    pub fn new(storage: Arc<Mutex<Storage>>) -> Arc<Self> {
        let files = storage
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .activity_files(now_unix_ms() - 7 * 24 * 60 * 60 * 1000)
            .unwrap_or_default();
        let state = State {
            files: files
                .into_iter()
                .map(|mut f| {
                    f.active_actors.clear();
                    (f.id.clone(), f)
                })
                .collect(),
            ..State::default()
        };
        Arc::new(Self {
            state: Mutex::new(state),
            storage,
            observers: Mutex::new(HashMap::new()),
        })
    }
    pub fn snapshot(&self) -> ActivitySnapshot {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        ActivitySnapshot {
            revision: state.revision.to_string(),
            observed_at: now_unix_ms(),
            actors: state.actors.values().cloned().collect(),
            files: state.files.values().cloned().collect(),
        }
    }
    pub fn clear(&self) -> Result<(), crate::DesktopError> {
        self.storage
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .activity_clear()?;
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        s.files.retain(|_, f| !f.active_actors.is_empty());
        for f in s.files.values_mut() {
            f.touched_at = 0;
        }
        s.revision += 1;
        Ok(())
    }
    pub fn remove(&self, id: &str) {
        if let Some(task) = self
            .observers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id)
        {
            task.abort();
        }
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let removed: HashSet<String> = s
            .actors
            .values()
            .filter(|a| a.session_id == id)
            .map(|a| a.id.clone())
            .collect();
        s.actors.retain(|_, a| a.session_id != id);
        for f in s.files.values_mut() {
            f.active_actors.retain(|a| !removed.contains(a));
        }
        s.tools.retain(|key, _| !key.starts_with(&format!("{id}|")));
        s.cursors
            .retain(|key, _| !key.starts_with(&format!("{id}|")));
        s.confirmed
            .retain(|key, _| !key.starts_with(&format!("{id}|")));
        s.roots.remove(id);
        s.sources.remove(id);
        s.revision += 1;
    }
    pub fn observe(self: &Arc<Self>, actor: SessionActor, root: PathBuf) {
        let observer_id = actor.handle().id.clone();
        self.remove(&observer_id);
        let service = Arc::clone(self);
        let mut events = actor.subscribe();
        let task = tokio::spawn(async move {
            let Ok(snapshot) = actor.snapshot().await else {
                return;
            };
            let id = actor.handle().id.clone();
            let workspace = service
                .storage
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .workspace_list()
                .unwrap_or_default()
                .into_iter()
                .find(|w| w.canonical_root == root);
            let Some(workspace) = workspace else { return };
            let title = service
                .storage
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .session_by_agent_id(
                    &workspace.id,
                    snapshot.agent_session_id.as_deref().unwrap_or(&id),
                )
                .ok()
                .flatten()
                .and_then(|r| r.title_overlay)
                .unwrap_or_else(|| snapshot.provider.label().to_string());
            {
                let mut s = service.state.lock().unwrap_or_else(|p| p.into_inner());
                s.roots.insert(id.clone(), root);
                if let Some(source) = snapshot.agent_session_id {
                    s.sources.insert(id.clone(), source);
                }
                s.actors.insert(
                    id.clone(),
                    ActivityActor {
                        id: id.clone(),
                        session_id: id.clone(),
                        workspace_id: workspace.id,
                        parent_id: None,
                        name: title,
                        provider: snapshot.provider,
                        model: None,
                        status: phase_name(&snapshot.foreground),
                        task: String::new(),
                        operation: "idle".into(),
                        file_id: None,
                        last_seen: now_unix_ms(),
                        waiting_reason: None,
                        retry_at_unix_ms: None,
                        native: false,
                        generation: actor.handle().attachment_generation,
                    },
                );
                s.revision += 1;
            }
            // Subscribe first, then replay; duplicate buffered updates are rejected by cursor.
            if let Ok(history) = actor.history(0, 20_000).await {
                for event in history {
                    service.ingest(&event, true);
                }
            }
            if let Ok(current) = actor.snapshot().await {
                service.sync_phase(
                    &id,
                    &current.foreground,
                    !current.autonomous_turns.is_empty(),
                );
            }
            while let Some(event) = events.recv().await {
                if matches!(event.payload, SessionEvent::SnapshotNeeded { .. }) {
                    // Drop partial tool projections, rebuild from current actor state, and
                    // advance the cursor. Unknown replay recency never creates fresh blooms.
                    if let Ok(snapshot) = actor.snapshot().await {
                        let mut s = service.state.lock().unwrap_or_else(|p| p.into_inner());
                        s.tools.retain(|key, _| !key.starts_with(&format!("{id}|")));
                        for (tool_id, tool) in &snapshot.tool_calls {
                            s.tools.insert(
                                format!(
                                    "{id}|{}|{tool_id}",
                                    snapshot.handle.attachment_generation.0
                                ),
                                compact_tool(tool.clone()),
                            );
                        }
                        for a in s
                            .actors
                            .values_mut()
                            .filter(|a| a.session_id == id && a.native)
                        {
                            a.status = "unknown".into();
                            a.file_id = None;
                        }
                        for f in s.files.values_mut() {
                            f.active_actors
                                .retain(|a| a != &id && !a.starts_with(&format!("{id}/")));
                        }
                        if let Some(a) = s.actors.get_mut(&id) {
                            a.status = actor_phase(
                                &snapshot.foreground,
                                !snapshot.autonomous_turns.is_empty(),
                            );
                            a.file_id = None;
                            a.last_seen = now_unix_ms();
                        }
                        let cursor = format!("{id}|{}", snapshot.handle.attachment_generation.0);
                        s.cursors.insert(cursor, snapshot.last_sequence.0);
                        s.revision += 1;
                    }
                    if let Ok(history) = actor.history(0, 20_000).await {
                        // Restore native nodes separately; file history comes from summaries.
                        for event in history {
                            if matches!(event.payload, SessionEvent::RuntimeEvent(_)) {
                                service.runtime_replay(&event);
                            }
                        }
                    }
                    {
                        let mut s = service.state.lock().unwrap_or_else(|p| p.into_inner());
                        reconcile_tools(&mut s, &id);
                        prune(&mut s);
                    }
                    continue;
                }
                service.ingest(&event, false);
                if matches!(event.payload, SessionEvent::Turn(_))
                    && let Ok(current) = actor.snapshot().await
                {
                    service.sync_phase(
                        &id,
                        &current.foreground,
                        !current.autonomous_turns.is_empty(),
                    );
                }
                if matches!(event.payload, SessionEvent::Exited(_)) {
                    break;
                }
            }
            service.remove(&id);
        });
        self.observers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(observer_id, task.abort_handle());
    }
    fn sync_phase(&self, id: &str, phase: &crate::supervisor::TurnPhase, autonomous: bool) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(a) = s.actors.get_mut(id) {
            a.status = actor_phase(phase, autonomous);
        }
        reconcile_tools(&mut s, id);
        prune(&mut s);
        s.revision += 1;
    }
    fn runtime_replay(&self, event: &EventEnvelope) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let SessionEvent::RuntimeEvent(runtime) = &event.payload {
            apply_runtime(&mut s, &event.session.id, runtime, true);
        }
    }
    fn ingest(&self, event: &EventEnvelope, historical: bool) {
        let mut saves = Vec::new();
        {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let session = &event.session.id;
            if s.actors
                .get(session)
                .is_none_or(|a| a.generation != event.session.attachment_generation)
            {
                return;
            }
            let cursor = format!("{session}|{}", event.session.attachment_generation.0);
            if event.sequence.0 <= *s.cursors.get(&cursor).unwrap_or(&0) {
                return;
            }
            s.cursors.insert(cursor.clone(), event.sequence.0);
            if !historical && let Some(a) = s.actors.get_mut(session) {
                a.last_seen = now_unix_ms();
            }
            let mut changed = true;
            match &event.payload {
                SessionEvent::Attachment {
                    agent_session_id: Some(source),
                    ..
                } => {
                    s.sources.insert(session.clone(), source.clone());
                }
                SessionEvent::Quota(quota) => {
                    if let Some(a) = s.actors.get_mut(session) {
                        if quota.status == crate::agents::events::QuotaStatus::Rejected
                            && matches!(a.status.as_str(), "working" | "starting")
                        {
                            a.status = "waiting".into();
                            a.operation = "quota".into();
                            a.waiting_reason = Some(
                                "The provider is waiting for its usage window to reset".into(),
                            );
                            a.retry_at_unix_ms =
                                quota.available_again_at().map(|t| t as i64 * 1000);
                        } else if a.operation == "quota"
                            && quota.status != crate::agents::events::QuotaStatus::Rejected
                        {
                            a.status = "unknown".into();
                            a.operation = "idle".into();
                            a.waiting_reason = None;
                            a.retry_at_unix_ms = None;
                        }
                    }
                }
                SessionEvent::RuntimeEvent(runtime) => {
                    apply_runtime(&mut s, session, runtime, historical);
                    reconcile_tools(&mut s, session);
                }
                SessionEvent::Turn(effect) => {
                    if let Some(a) = s.actors.get_mut(session) {
                        match effect {
                            TurnEffect::Started { .. } => {
                                a.status = "working".into();
                                a.operation = "thinking".into();
                                a.waiting_reason = None;
                                a.retry_at_unix_ms = None;
                            }
                            TurnEffect::Settled { phase, .. } => {
                                a.status = phase_name(phase);
                                a.operation = "idle".into();
                                a.file_id = None;
                            }
                            TurnEffect::Cancelling { .. } => a.status = "waiting".into(),
                            _ => {}
                        }
                    }
                    if matches!(effect, TurnEffect::Settled { .. }) {
                        for (key, t) in &mut s.tools {
                            if key.starts_with(&format!("{session}|"))
                                && t.meta.as_ref().and_then(|m| m.get("agentId")).is_none()
                                && !matches!(
                                    t.status.as_deref(),
                                    Some("completed" | "failed" | "cancelled")
                                )
                            {
                                t.status = Some("cancelled".into());
                            }
                        }
                        reconcile_tools(&mut s, session);
                    }
                }
                SessionEvent::Exited(_) => {
                    let ids: HashSet<_> = s
                        .actors
                        .values()
                        .filter(|a| a.session_id == *session)
                        .map(|a| a.id.clone())
                        .collect();
                    for a in s.actors.values_mut().filter(|a| a.session_id == *session) {
                        a.status = "idle".into();
                        a.file_id = None;
                    }
                    for f in s.files.values_mut() {
                        f.active_actors.retain(|a| !ids.contains(a));
                    }
                }
                SessionEvent::Update(
                    SessionUpdate::ToolCall(patch) | SessionUpdate::ToolCallUpdate(patch),
                ) => {
                    let Some(tool_id) = patch.tool_call_id.as_ref() else {
                        return;
                    };
                    let key = format!("{cursor}|{tool_id}");
                    let mut tool = s
                        .tools
                        .get(&key)
                        .map(|t| t.merging(patch))
                        .unwrap_or_else(|| patch.clone());
                    tool.raw_output = None;
                    tool.content = None;
                    let root = s.roots.get(session).cloned().unwrap_or_default();
                    let targets = extract::targets(&tool, &root);
                    let parent = s.actors[session].clone();
                    let source = s
                        .sources
                        .get(session)
                        .cloned()
                        .unwrap_or_else(|| session.clone());
                    let child = tool
                        .meta
                        .as_ref()
                        .and_then(|m| m.get("agentId"))
                        .and_then(serde_json::Value::as_str)
                        .map(|id| format!("{session}/child/{id}"));
                    let owner = child
                        .filter(|id| s.actors.contains_key(id))
                        .unwrap_or_else(|| session.clone());
                    let complete = tool.status.as_deref() == Some("completed");
                    let terminal = complete
                        || tool.status.as_deref() == Some("failed")
                        || tool.status.as_deref() == Some("cancelled");
                    let replay_key = format!("{key}|replayed");
                    if historical && complete {
                        s.confirmed.insert(replay_key.clone(), event.sequence.0);
                    }
                    let operation = if targets.is_empty() {
                        if tool.kind.as_deref() == Some("execute") {
                            "build"
                        } else {
                            "thinking"
                        }
                    } else {
                        targets[0].2.as_str()
                    };
                    if let Some(a) = s.actors.get_mut(&owner) {
                        a.operation = operation.into();
                        a.file_id = targets
                            .first()
                            .map(|(p, _, _)| format!("{}:{p}", parent.workspace_id));
                        if terminal {
                            a.file_id = None;
                        }
                        if !historical {
                            a.task = tool.title.clone().unwrap_or_default();
                        }
                    }
                    for (path, external, operation) in targets {
                        let id = format!("{}:{path}", parent.workspace_id);
                        let confirmation = format!("{key}|{id}");
                        let first_complete = complete
                            && !s.confirmed.contains_key(&confirmation)
                            && !s.confirmed.contains_key(&replay_key);
                        if first_complete {
                            s.confirmed.insert(confirmation, event.sequence.0);
                        }
                        if historical && terminal {
                            if let Some(f) = s.files.get_mut(&id) {
                                f.active_actors.retain(|a| a != &owner);
                            }
                            continue;
                        }
                        let f = s.files.entry(id.clone()).or_insert_with(|| FileActivity {
                            id,
                            workspace_id: parent.workspace_id.clone(),
                            path,
                            external,
                            operation: operation.clone(),
                            touched_at: 0,
                            session_id: source.clone(),
                            active_actors: Vec::new(),
                        });
                        if terminal {
                            f.active_actors.retain(|a| a != &owner);
                        } else if !f.active_actors.contains(&owner) {
                            f.active_actors.push(owner.clone());
                        }
                        if first_complete && !historical {
                            f.touched_at = now_unix_ms();
                            f.operation = operation;
                            f.session_id = source.clone();
                            let mut saved = f.clone();
                            saved.active_actors.clear();
                            saves.push(saved);
                        }
                    }
                    s.tools.insert(key, compact_tool(tool));
                    reconcile_tools(&mut s, session);
                    if s.tools.len() > 4096 {
                        let remove: Vec<_> = s
                            .tools
                            .iter()
                            .filter(|(_, t)| {
                                matches!(
                                    t.status.as_deref(),
                                    Some("completed" | "failed" | "cancelled")
                                )
                            })
                            .take(s.tools.len() - 4096)
                            .map(|(k, _)| k.clone())
                            .collect();
                        for k in remove {
                            s.tools.remove(&k);
                        }
                    }
                    prune(&mut s);
                }
                _ => changed = false,
            }
            if changed {
                prune(&mut s);
                s.revision += 1;
            }
        }
        if !saves.is_empty() {
            let db = self.storage.lock().unwrap_or_else(|p| p.into_inner());
            for file in saves {
                if let Err(error) = db.activity_save(&file) {
                    tracing::warn!(%error,"could not persist Chill activity");
                }
            }
        }
    }
}
fn phase_name(phase: &crate::supervisor::TurnPhase) -> String {
    use crate::supervisor::TurnPhase;
    match phase {
        TurnPhase::Running => "working",
        TurnPhase::AwaitingUser => "attention",
        TurnPhase::Failed => "failed",
        TurnPhase::Unknown => "unknown",
        _ => "idle",
    }
    .into()
}
fn actor_phase(phase: &crate::supervisor::TurnPhase, autonomous: bool) -> String {
    let phase = phase_name(phase);
    if autonomous && !matches!(phase.as_str(), "attention" | "failed") {
        "working".into()
    } else {
        phase
    }
}
fn apply_runtime(s: &mut State, session: &str, event: &RuntimeEvent, historical: bool) {
    match event {
        RuntimeEvent::SubagentStateChanged {
            id,
            name,
            status,
            model,
            task,
            parent_id,
            harness,
            outcome,
            generation,
            generation_started_at_unix_ms,
            ..
        } => {
            let Some(parent) = s.actors.get(session).cloned() else {
                return;
            };
            let key = format!("{session}/child/{id}");
            let state = if *outcome == Some(crate::agents::events::GenerationOutcome::Failed) {
                "failed"
            } else {
                match status {
                    SubagentStatus::Starting => "starting",
                    SubagentStatus::Working => "working",
                    SubagentStatus::Idle if harness == "codex" => "unknown",
                    _ => "idle",
                }
            };
            if *status == SubagentStatus::Removed {
                s.actors.remove(&key);
                forget_targets(s, session, &HashSet::from([key.clone()]));
            } else {
                s.actors.insert(
                    key.clone(),
                    ActivityActor {
                        id: key,
                        session_id: session.into(),
                        workspace_id: parent.workspace_id,
                        parent_id: Some(
                            parent_id
                                .as_ref()
                                .map(|p| format!("{session}/child/{p}"))
                                .unwrap_or_else(|| session.into()),
                        ),
                        name: name.chars().take(80).collect(),
                        provider: parent.provider,
                        model: model.clone(),
                        status: state.into(),
                        task: task.chars().take(400).collect(),
                        operation: "thinking".into(),
                        file_id: None,
                        last_seen: if historical {
                            *generation_started_at_unix_ms as i64
                        } else {
                            now_unix_ms()
                        },
                        waiting_reason: None,
                        retry_at_unix_ms: None,
                        native: true,
                        generation: crate::ids::DecimalId(*generation),
                    },
                );
            }
            if !matches!(state, "working" | "starting") {
                forget_targets(
                    s,
                    session,
                    &HashSet::from([format!("{session}/child/{id}")]),
                );
            }
        }
        RuntimeEvent::SubagentDescendantsRemoved { ancestor_id } => {
            let mut removed = HashSet::from([format!("{session}/child/{ancestor_id}")]);
            loop {
                let before = removed.len();
                for a in s.actors.values() {
                    if a.parent_id.as_ref().is_some_and(|p| removed.contains(p)) {
                        removed.insert(a.id.clone());
                    }
                }
                if before == removed.len() {
                    break;
                }
            }
            s.actors.retain(|id, _| !removed.contains(id));
            forget_targets(s, session, &removed);
        }
    }
}

fn reconcile_tools(s: &mut State, session: &str) {
    let owners: HashSet<_> = s
        .actors
        .values()
        .filter(|a| a.session_id == session)
        .map(|a| a.id.clone())
        .collect();
    for f in s.files.values_mut() {
        f.active_actors.retain(|a| !owners.contains(a));
    }
    for a in s.actors.values_mut().filter(|a| a.session_id == session) {
        a.file_id = None;
    }
    let Some(root) = s.roots.get(session).cloned() else {
        return;
    };
    let Some(parent) = s.actors.get(session).cloned() else {
        return;
    };
    for (key, tool) in &s.tools {
        if !key.starts_with(&format!("{session}|"))
            || matches!(
                tool.status.as_deref(),
                Some("completed" | "failed" | "cancelled")
            )
        {
            continue;
        }
        let child = tool
            .meta
            .as_ref()
            .and_then(|m| m.get("agentId"))
            .and_then(serde_json::Value::as_str)
            .map(|id| format!("{session}/child/{id}"));
        let owner = child
            .filter(|id| s.actors.contains_key(id))
            .unwrap_or_else(|| session.to_string());
        if !s
            .actors
            .get(&owner)
            .is_some_and(|a| matches!(a.status.as_str(), "working" | "starting"))
        {
            continue;
        }
        for (path, external, operation) in extract::targets(tool, &root) {
            let id = format!("{}:{path}", parent.workspace_id);
            let f = s.files.entry(id.clone()).or_insert_with(|| FileActivity {
                id: id.clone(),
                workspace_id: parent.workspace_id.clone(),
                path,
                external,
                operation: operation.clone(),
                touched_at: 0,
                session_id: session.into(),
                active_actors: Vec::new(),
            });
            if !f.active_actors.contains(&owner) {
                f.active_actors.push(owner.clone());
            }
            if let Some(a) = s.actors.get_mut(&owner) {
                a.file_id = Some(id);
                a.operation = operation;
            }
        }
    }
}

// Activity is bounded independently from transcript retention. Never evict a
// currently targeted file; the display can still aggregate it into a colony.
fn prune(s: &mut State) {
    let since = now_unix_ms() - 7 * 24 * 60 * 60 * 1000;
    s.files
        .retain(|_, f| !f.active_actors.is_empty() || f.touched_at >= since);
    let workspaces: HashSet<_> = s.files.values().map(|f| f.workspace_id.clone()).collect();
    for workspace in workspaces {
        let count = s
            .files
            .values()
            .filter(|f| f.workspace_id == workspace)
            .count();
        if count > 5000 {
            let mut inactive: Vec<_> = s
                .files
                .values()
                .filter(|f| f.workspace_id == workspace && f.active_actors.is_empty())
                .map(|f| (f.touched_at, f.id.clone()))
                .collect();
            inactive.sort();
            for (_, id) in inactive.into_iter().take(count - 5000) {
                s.files.remove(&id);
            }
        }
    }
    if s.files.len() > 20_000 {
        let mut inactive: Vec<_> = s
            .files
            .values()
            .filter(|f| f.active_actors.is_empty())
            .map(|f| (f.touched_at, f.id.clone()))
            .collect();
        inactive.sort();
        for (_, id) in inactive.into_iter().take(s.files.len() - 20_000) {
            s.files.remove(&id);
        }
    }
    if s.confirmed.len() > 8192 {
        let mut oldest: Vec<_> = s
            .confirmed
            .iter()
            .map(|(id, seq)| (*seq, id.clone()))
            .collect();
        oldest.sort();
        for (_, id) in oldest.into_iter().take(s.confirmed.len() - 8192) {
            s.confirmed.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ids::{DecimalId, SessionHandle},
        supervisor::{TurnKind, TurnPhase},
    };
    use serde_json::json;
    #[test]
    fn attention_is_not_hidden_by_autonomous_work_or_snapshot_recovery() {
        assert_eq!(actor_phase(&TurnPhase::AwaitingUser, true), "attention");
        assert_eq!(actor_phase(&TurnPhase::Failed, true), "failed");
        assert_eq!(actor_phase(&TurnPhase::Idle, true), "working");
        assert_eq!(actor_phase(&TurnPhase::Idle, false), "idle");
    }

    fn setup() -> (Arc<ActivityService>, String) {
        let db = Storage::open_in_memory().unwrap();
        let workspace = db.workspace_upsert("/repo", "/repo", "repo").unwrap();
        let service = ActivityService::new(Arc::new(Mutex::new(db)));
        {
            let mut s = service.state.lock().unwrap();
            s.roots.insert("s".into(), PathBuf::from("/repo"));
            s.sources.insert("s".into(), "canonical-session".into());
            s.actors.insert(
                "s".into(),
                ActivityActor {
                    id: "s".into(),
                    session_id: "s".into(),
                    workspace_id: workspace.id.clone(),
                    parent_id: None,
                    name: "Keeper".into(),
                    provider: Provider::Claude,
                    model: None,
                    status: "working".into(),
                    task: String::new(),
                    operation: "thinking".into(),
                    file_id: None,
                    last_seen: now_unix_ms(),
                    waiting_reason: None,
                    retry_at_unix_ms: None,
                    native: false,
                    generation: DecimalId(1),
                },
            );
        }
        (service, workspace.id)
    }
    fn event(seq: u64, payload: SessionEvent) -> EventEnvelope {
        EventEnvelope::new(
            SessionHandle {
                id: "s".into(),
                attachment_generation: DecimalId(1),
            },
            DecimalId(seq),
            payload,
        )
    }
    fn tool(seq: u64, value: serde_json::Value) -> EventEnvelope {
        event(
            seq,
            SessionEvent::Update(SessionUpdate::ToolCallUpdate(ToolPatch::from_object(
                value.as_object().unwrap(),
            ))),
        )
    }
    #[test]
    fn overlapping_partial_tools_keep_the_leaf_active_and_confirm_once() {
        let (service, _) = setup();
        service.ingest(&tool(1,json!({"toolCallId":"a","name":"Edit","status":"in_progress","rawInput":{"file_path":"a.ts"}})),false);
        service.ingest(&tool(2,json!({"toolCallId":"b","name":"Edit","status":"in_progress","rawInput":{"file_path":"a.ts"}})),false);
        service.ingest(
            &tool(3, json!({"toolCallId":"a","status":"completed"})),
            false,
        );
        let first = service.snapshot().files[0].clone();
        assert_eq!(first.active_actors, vec!["s"]);
        assert!(first.touched_at > 0);
        assert_eq!(first.session_id, "canonical-session");
        service.ingest(
            &tool(3, json!({"toolCallId":"b","status":"completed"})),
            false,
        ); // duplicate cursor
        assert_eq!(service.snapshot().files[0].active_actors, vec!["s"]);
        service.ingest(
            &tool(
                4,
                json!({"toolCallId":"a","status":"completed","title":"extra patch"}),
            ),
            false,
        );
        assert_eq!(service.snapshot().files[0].touched_at, first.touched_at);
        service.ingest(&tool(5, json!({"toolCallId":"b","status":"failed"})), false);
        assert!(service.snapshot().files[0].active_actors.is_empty());
    }
    #[test]
    fn replay_and_failed_edits_do_not_create_fresh_history() {
        let (service, _) = setup();
        service.ingest(&tool(1,json!({"toolCallId":"old","name":"Edit","status":"completed","rawInput":{"file_path":"old.ts"}})),true);
        service.ingest(&tool(2,json!({"toolCallId":"fail","name":"Edit","status":"in_progress","rawInput":{"file_path":"fail.ts"}})),false);
        service.ingest(
            &tool(3, json!({"toolCallId":"fail","status":"failed"})),
            false,
        );
        assert!(service.snapshot().files.is_empty());
    }
    #[test]
    fn turn_settlement_and_removal_release_pending_targets() {
        let (service, _) = setup();
        service.ingest(&tool(1,json!({"toolCallId":"a","name":"Read","status":"in_progress","rawInput":{"file_path":"a.ts"}})),false);
        assert_eq!(service.snapshot().files[0].active_actors, vec!["s"]);
        service.ingest(
            &event(
                2,
                SessionEvent::Turn(TurnEffect::Settled {
                    kind: TurnKind::Foreground,
                    turn_id: None,
                    phase: TurnPhase::Cancelled,
                    stop_reason: None,
                    error: None,
                }),
            ),
            false,
        );
        assert!(
            service
                .snapshot()
                .files
                .iter()
                .all(|f| f.active_actors.is_empty())
        );
        service.remove("s");
        assert!(service.snapshot().actors.is_empty());
        assert!(service.state.lock().unwrap().tools.is_empty());
    }
    #[test]
    fn snapshot_tools_rebuild_active_leaves_without_confirming_recency() {
        let (service, _) = setup();
        let mut s = service.state.lock().unwrap();
        s.tools.insert(
            "s|1|a".into(),
            ToolPatch::from_object(
                json!({"name":"Read","status":"in_progress","rawInput":{"file_path":"a.ts"}})
                    .as_object()
                    .unwrap(),
            ),
        );
        reconcile_tools(&mut s, "s");
        assert_eq!(s.files.values().next().unwrap().touched_at, 0);
        assert_eq!(s.files.values().next().unwrap().active_actors, vec!["s"]);
    }
    fn child(
        id: &str,
        parent: Option<&str>,
        harness: &str,
        status: SubagentStatus,
    ) -> RuntimeEvent {
        RuntimeEvent::SubagentStateChanged {
            id: id.into(),
            name: id.into(),
            status,
            outcome: None,
            generation: 1,
            task: "Review".into(),
            parent_id: parent.map(str::to_string),
            parent_name: None,
            harness: harness.into(),
            model: None,
            created_at_unix_ms: 1,
            generation_started_at_unix_ms: 1,
            generation_finished_at_unix_ms: None,
        }
    }
    #[test]
    fn native_identity_is_scoped_and_codex_dispatch_is_not_completion() {
        let (service, _) = setup();
        service.ingest(
            &event(
                1,
                SessionEvent::RuntimeEvent(child("c", None, "codex", SubagentStatus::Idle)),
            ),
            false,
        );
        let snapshot = service.snapshot();
        let c = snapshot.actors.iter().find(|a| a.native).unwrap();
        assert_eq!(c.id, "s/child/c");
        assert_eq!(c.status, "unknown");
        assert!(c.last_seen > 1);
        service.ingest(
            &event(
                2,
                SessionEvent::RuntimeEvent(child(
                    "grand",
                    Some("c"),
                    "claude-code",
                    SubagentStatus::Working,
                )),
            ),
            false,
        );
        service.ingest(
            &event(
                3,
                SessionEvent::RuntimeEvent(RuntimeEvent::SubagentDescendantsRemoved {
                    ancestor_id: "c".into(),
                }),
            ),
            false,
        );
        assert_eq!(service.snapshot().actors.len(), 1);
    }
    #[test]
    fn restart_restores_only_successful_file_summaries() {
        let (service, workspace) = setup();
        service.ingest(&tool(1,json!({"toolCallId":"a","name":"Edit","status":"completed","rawInput":{"file_path":"a.ts"}})),false);
        let restarted = ActivityService::new(Arc::clone(&service.storage));
        let snapshot = restarted.snapshot();
        assert!(snapshot.actors.is_empty());
        assert_eq!(snapshot.files.len(), 1);
        assert!(snapshot.files[0].active_actors.is_empty());
        service
            .storage
            .lock()
            .unwrap()
            .workspace_delete(&workspace)
            .unwrap();
        assert!(
            service
                .storage
                .lock()
                .unwrap()
                .activity_files(0)
                .unwrap()
                .is_empty()
        );
        restarted.clear().unwrap();
        assert!(restarted.snapshot().files.is_empty());
    }
    #[test]
    fn late_file_evidence_is_confirmed_once_after_a_terminal_patch() {
        let (service, _) = setup();
        service.ingest(
            &tool(
                1,
                json!({"toolCallId":"a","name":"Edit","status":"completed"}),
            ),
            false,
        );
        service.ingest(
            &tool(
                2,
                json!({"toolCallId":"a","rawInput":{"file_path":"late.ts"}}),
            ),
            false,
        );
        assert_eq!(service.snapshot().files.len(), 1);
        let touched = service.snapshot().files[0].touched_at;
        assert!(touched > 0);
        service.ingest(
            &tool(3, json!({"toolCallId":"a","status":"completed"})),
            false,
        );
        assert_eq!(service.snapshot().files[0].touched_at, touched);
    }
    #[test]
    fn stored_tool_projections_exclude_file_contents_and_outputs() {
        let input=ToolPatch::from_object(json!({"name":"write_to_file","kind":"edit","rawInput":{"TargetFile":"/repo/a.ts","CodeContent":"secret file body","arbitrary":{"large":"payload"}},"rawOutput":"secret output","content":[{"text":"output"}]}).as_object().unwrap());
        let compact = compact_tool(input);
        assert!(compact.raw_output.is_none());
        assert!(compact.content.is_none());
        assert_eq!(
            compact.raw_input.as_ref().unwrap(),
            &json!({"TargetFile":"/repo/a.ts"})
        );
        assert_eq!(
            extract::targets(&compact, std::path::Path::new("/repo"))[0].0,
            "a.ts"
        );
    }
    #[test]
    fn stale_attachment_updates_are_ignored() {
        let (service, _) = setup();
        let mut stale = tool(
            1,
            json!({"toolCallId":"a","name":"Edit","status":"completed","rawInput":{"file_path":"a.ts"}}),
        );
        stale.session.attachment_generation = DecimalId(0);
        service.ingest(&stale, false);
        assert!(service.snapshot().files.is_empty());
    }
}

fn forget_targets(s: &mut State, session: &str, removed: &HashSet<String>) {
    for f in s.files.values_mut() {
        f.active_actors.retain(|a| !removed.contains(a));
    }
    s.tools.retain(|key, t| {
        !key.starts_with(&format!("{session}|"))
            || !t
                .meta
                .as_ref()
                .and_then(|m| m.get("agentId"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|id| removed.contains(&format!("{session}/child/{id}")))
    });
}

// Retain structured evidence needed by future partial patches, never tool file
// contents, shell scripts, image data, or arbitrary MCP request/output bodies.
fn compact_tool(mut tool: ToolPatch) -> ToolPatch {
    use serde_json::{Value, json};
    fn headers(value: &str) -> String {
        value
            .lines()
            .filter(|line| {
                [
                    "*** Update File: ",
                    "*** Add File: ",
                    "*** Delete File: ",
                    "*** Move to: ",
                ]
                .iter()
                .any(|p| line.starts_with(p))
            })
            .take(128)
            .collect::<Vec<_>>()
            .join("\n")
    }
    tool.raw_output = None;
    tool.content = None;
    tool.title = tool.title.map(|v| v.chars().take(400).collect());
    tool.meta = tool.meta.and_then(|m| {
        m.get("agentId")
            .and_then(Value::as_str)
            .map(|id| json!({"agentId":id}))
    });
    tool.locations = tool.locations.and_then(|v| {
        v.as_array().map(|a| {
            Value::Array(
                a.iter()
                    .take(64)
                    .filter_map(|item| {
                        item.get("path")
                            .and_then(Value::as_str)
                            .map(|p| json!({"path":p}))
                    })
                    .collect(),
            )
        })
    });
    tool.raw_input = tool.raw_input.map(|value| match value {
        Value::String(text) => Value::String(headers(&text)),
        Value::Object(object) => {
            let mut safe = serde_json::Map::new();
            for key in [
                "cwd",
                "file_path",
                "filePath",
                "path",
                "absolute_path",
                "TargetFile",
                "AbsolutePath",
            ] {
                if let Some(value) = object
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|v| v.len() <= 4096)
                {
                    safe.insert(key.into(), json!(value));
                }
            }
            if let Some(patch) = object.get("patch").and_then(Value::as_str) {
                safe.insert("patch".into(), json!(headers(patch)));
            }
            for key in ["changes", "actions"] {
                if let Some(items) = object.get(key).and_then(Value::as_array) {
                    safe.insert(
                        key.into(),
                        Value::Array(
                            items
                                .iter()
                                .take(64)
                                .map(|item| {
                                    let mut fields = serde_json::Map::new();
                                    for field in ["path", "kind", "type"] {
                                        if let Some(value) = item.get(field)
                                            && (value.is_string()
                                                && value.as_str().is_some_and(|v| v.len() <= 4096)
                                                || field == "kind")
                                        {
                                            fields.insert(
                                                field.into(),
                                                match value {
                                                    Value::Object(k) => {
                                                        let mut kind = serde_json::Map::new();
                                                        if let Some(t) =
                                                            k.get("type").and_then(Value::as_str)
                                                        {
                                                            kind.insert("type".into(), json!(t));
                                                        }
                                                        if k.contains_key("delete") {
                                                            kind.insert(
                                                                "delete".into(),
                                                                json!(true),
                                                            );
                                                        }
                                                        Value::Object(kind)
                                                    }
                                                    _ => value.clone(),
                                                },
                                            );
                                        }
                                    }
                                    Value::Object(fields)
                                })
                                .collect(),
                        ),
                    );
                }
            }
            Value::Object(safe)
        }
        _ => Value::Null,
    });
    tool
}
