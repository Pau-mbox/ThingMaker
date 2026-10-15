//! Read-only activity facts. Polling snapshots is deliberately bounded and also
//! works over the phone's existing authenticated command bridge.
use super::{CommandResult, storage_error};
use crate::state::AppState;
use serde::Serialize;
use tauri::State;
use thingmaker_supervisor::{activity::ActivitySnapshot, delegation::jobs::JobView};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityGoal {
    id: String,
    workspace_id: String,
    title: String,
    state: String,
    verified: usize,
    total: usize,
    pending: usize,
    session_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityWorktree {
    workspace_id: String,
    source_workspace_id: String,
    branch: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityViewSnapshot {
    #[serde(flatten)]
    activity: ActivitySnapshot,
    jobs: Vec<JobView>,
    goals: Vec<ActivityGoal>,
    worktrees: Vec<ActivityWorktree>,
}
#[tauri::command]
pub fn activity_snapshot(state: State<'_, AppState>) -> CommandResult<ActivityViewSnapshot> {
    let mut activity = state.activity.snapshot();
    for actor in &mut activity.actors {
        if !actor.native {
            actor.model = state.actor_model(&actor.session_id);
        }
    }
    let mut jobs = Vec::new();
    if let Some(delegation) = state.delegation.get() {
        for id in state.actor_ids() {
            jobs.extend(delegation.jobs(&id));
        }
    }
    // Recent job records remain useful for quiet success/failure states; bound
    // text and count rather than transferring every historical worker report.
    jobs.sort_by_key(|j| std::cmp::Reverse(j.started_at_unix_ms));
    jobs.truncate(500);
    for job in &mut jobs {
        job.task = job.task.chars().take(400).collect();
        job.result = None;
        job.error = job.error.take().map(|e| e.chars().take(500).collect());
    }
    let goals = state
        .with_storage(|db| {
            let mut goals = Vec::new();
            for workspace in db.workspace_list()? {
                for goal in db.odyssey_list(&workspace.id)? {
                    if let Some(view) = db.odyssey_view(&goal.id)? {
                        goals.push(ActivityGoal {
                            id: goal.id.clone(),
                            workspace_id: workspace.id.clone(),
                            title: goal.title,
                            state: goal.state.as_str().into(),
                            verified: view
                                .milestones
                                .iter()
                                .filter(|m| m.state.as_str() == "verified")
                                .count(),
                            total: view.milestones.len(),
                            pending: db
                                .question_list(&goal.id, 500)?
                                .iter()
                                .filter(|q| q.state.as_str() == "open")
                                .count()
                                + db.plan_change_list(&goal.id, 500)?
                                    .iter()
                                    .filter(|p| p.state.as_str() == "proposed")
                                    .count(),
                            session_id: goal
                                .session_id
                                .as_deref()
                                .and_then(|id| db.session_get(id).ok().flatten())
                                .map(|s| s.agent_session_id),
                        });
                    }
                }
            }
            Ok::<_, thingmaker_supervisor::storage::migrations::StorageError>(goals)
        })
        .map_err(storage_error)?;
    let worktrees = state
        .with_storage(|db| {
            let mut worktrees = Vec::new();
            for workspace in db.workspace_list()? {
                if let Some(tree) = db.worktree_by_path(&workspace.canonical_root)? {
                    worktrees.push(ActivityWorktree {
                        workspace_id: workspace.id,
                        source_workspace_id: tree.workspace_id,
                        branch: tree.branch,
                    });
                }
            }
            Ok::<_, thingmaker_supervisor::storage::migrations::StorageError>(worktrees)
        })
        .map_err(storage_error)?;
    Ok(ActivityViewSnapshot {
        activity,
        jobs,
        goals,
        worktrees,
    })
}
#[tauri::command]
pub fn activity_clear(state: State<'_, AppState>) -> CommandResult<()> {
    state.activity.clear()
}
