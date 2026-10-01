//! A run in its own branch and worktree (ADR-010).
//!
//! With isolation on, starting a goal in a Git repository gives it a branch
//! (`bigthing/<slug>`) and a worktree under the app's data directory, and
//! opens the run's orchestrator there. Two runs never edit the same tree, the
//! user's checkout is untouched until they merge, every checkpoint is a commit
//! on the branch, and a rollback is a reset to one of them.

use std::path::Path;

use serde::Serialize;

use super::{
    engine::{Engine, GoalState, Loaded, team_of},
    host::{EngineEvent, OpenSpec},
};
use crate::{
    DesktopError,
    review::git::{self, MergeOutcome},
    storage::odyssey::{JournalKind, OdysseyState},
    workspace::WorkspaceIdentity,
};

/// Commits the tree as a checkpoint; the commit, or `None` with nothing to
/// commit or no repository.
pub fn commit_checkpoint(root: &Path, message: &str) -> Option<String> {
    git::commit_all(root, message).ok().flatten()
}

/// A branch name from a goal's title: `bigthing/ship-onboarding-v2-3f2a`.
pub fn branch_for(title: &str, goal_id: &str) -> String {
    let words: Vec<String> = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .take(5)
        .map(str::to_string)
        .collect();
    let slug = if words.is_empty() { "run".to_string() } else { words.join("-") };
    format!("bigthing/{slug}-{}", &goal_id[..goal_id.len().min(6)])
}

/// One checkpoint commit on a run's branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommit {
    pub commit: String,
    pub subject: String,
}

impl Engine {
    /// Gives a draft goal its own branch and worktree, moves the goal there and
    /// opens its orchestrator in it.
    pub(crate) async fn isolate(&self, state: &mut GoalState, loaded: &Loaded) -> Result<(), DesktopError> {
        let goal = &loaded.goal;
        let source = self.db(|storage| storage.workspace_get(&goal.workspace_id))?.ok_or_else(|| DesktopError::not_ready("the goal's workspace is gone"))?;
        let root = Path::new(&source.canonical_root).to_path_buf();
        if !git::is_git_repository(&root) {
            return Err(DesktopError::unsupported("This workspace is not a Git repository, so the run cannot have its own worktree. Turn isolation off to run it here."));
        }
        let base = git::head_commit(&root).map_err(|_| DesktopError::unsupported("The repository has no commits yet, so there is nothing to branch the run from."))?;
        let branch = branch_for(&goal.title, &goal.id);
        let path = self.inner.data_dir.join("worktrees").join(&source.workspace_hash).join(branch.trim_start_matches("bigthing/"));
        let worktree = {
            let root = root.clone();
            let path = path.clone();
            let branch = branch.clone();
            let base = base.clone();
            tokio::task::spawn_blocking(move || git::worktree_add(&root, &path, &branch, &base)).await.map_err(|_| DesktopError::io("the worktree could not be created"))?
        };
        worktree?;
        let identity = WorkspaceIdentity::resolve(&path)?;
        let path_text = identity.canonical_root.to_string_lossy().into_owned();
        self.db(|storage| storage.worktree_insert(&source.id, &path_text, &branch, &base))?;
        let workspace = self.db(|storage| storage.workspace_upsert(&identity.canonical_root.to_string_lossy(), &identity.display_path, &identity.workspace_hash))?;
        self.db(|storage| storage.odyssey_set_worktree(&goal.id, &workspace.id, &source.id, &identity.canonical_root.to_string_lossy(), &branch, &base))?;

        // The run's orchestrator, in the worktree, leading the run's team.
        let current = self.live_for(goal, false).await;
        let team = team_of(goal);
        let provider = team.as_ref().and_then(|team| team.0.provider).or_else(|| current.as_ref().map(|live| live.provider)).unwrap_or_default();
        let combo = team.as_ref().map(|team| team.1.clone()).or_else(|| current.as_ref().and_then(|live| self.inner.delegation.as_ref().and_then(|delegation| delegation.combo(&live.handle))));
        let lead = team.map(|team| team.0).unwrap_or_default();
        let live = self.inner.host.open(OpenSpec { workspace_id: workspace.id.clone(), provider, model: lead.model, effort: lead.effort, combo, resume: None }).await?;
        self.inner.host.emit(EngineEvent::SessionOpened { workspace_id: live.workspace_id.clone(), handle: live.handle.clone(), agent_session_id: live.agent_session_id.clone() });
        let row = self.db(|storage| storage.odyssey_session_row(&workspace.id, &live.agent_session_id, Some(live.provider)))?.ok_or_else(|| DesktopError::not_ready("the run's session has no desktop record"))?;
        self.db(|storage| storage.odyssey_repoint(&goal.id, &row))?;
        self.journal(&goal.id, JournalKind::State, None, &format!("Started in its own worktree on branch {branch}"), Some(&format!("path={path_text}\nbase={base}")));
        state.pending = None;
        if let Some(current) = current {
            self.inner.session_goal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&current.handle);
        }
        let goal = self.load(&goal.id)?.goal;
        self.inner.host.emit(EngineEvent::Moved { goal_id: goal.id.clone(), from_agent_session_id: None, to_agent_session_id: live.agent_session_id.clone(), to_handle: live.handle.clone() });
        let _ = self.live_for(&goal, false).await;
        self.changed(&goal.id);
        Ok(())
    }

    /// The run's checkpoint commits, newest first.
    pub fn run_commits(&self, goal_id: &str) -> Result<Vec<RunCommit>, DesktopError> {
        let goal = self.load(goal_id)?.goal;
        let (Some(path), Some(base)) = (goal.worktree_path.as_deref(), goal.base_ref.as_deref()) else { return Ok(Vec::new()) };
        let range = format!("{base}..HEAD");
        let output = std::process::Command::new("git").args(["-C", path, "log", "--format=%H%x09%s", "-n", "200", &range]).output().map_err(|error| DesktopError::io(error.to_string()))?;
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_once('\t'))
            .map(|(commit, subject)| RunCommit { commit: commit.to_string(), subject: subject.to_string() })
            .collect())
    }

    /// Puts the run's worktree back to one of its checkpoints. The run is
    /// paused: what comes next is the user's call.
    pub async fn rollback(&self, goal_id: &str, commit: &str) -> Result<(), DesktopError> {
        let goal = self.load(goal_id)?.goal;
        let path = goal.worktree_path.clone().ok_or_else(|| DesktopError::unsupported("this run has no worktree of its own to roll back"))?;
        let known = self.run_commits(goal_id)?.iter().any(|entry| entry.commit == commit) || goal.base_ref.as_deref() == Some(commit);
        if !known {
            return Err(DesktopError::not_ready("that commit is not one of this run's checkpoints"));
        }
        if let Some(live) = self.live_for(&goal, false).await
            && self.watch(&live.handle).is_some_and(|watch| !watch.idle())
        {
            let _ = live.actor.cancel().await;
        }
        let commit_owned = commit.to_string();
        tokio::task::spawn_blocking(move || git::reset_hard(Path::new(&path), &commit_owned)).await.map_err(|_| DesktopError::io("the rollback did not finish"))??;
        if matches!(goal.state, OdysseyState::Running | OdysseyState::WaitingUsage) {
            self.set_state(goal_id, OdysseyState::Paused)?;
        }
        self.journal(goal_id, JournalKind::State, None, &format!("Rolled back to {}", &commit[..commit.len().min(10)]), Some("Everything after that checkpoint was dropped from the run's worktree. The run is paused; resume it to carry on from there."));
        self.queue_delta(goal_id, super::prompt::Delta::PlanEdited { summary: format!("the user rolled the worktree back to checkpoint {}; anything after it is gone, so read the tree again before continuing", &commit[..commit.len().min(10)]) });
        self.changed(goal_id);
        Ok(())
    }

    /// Merges the run's branch into the checkout it branched from. A merge
    /// that would conflict is aborted and the files are named.
    pub async fn merge_run(&self, goal_id: &str) -> Result<MergeOutcome, DesktopError> {
        let goal = self.load(goal_id)?.goal;
        let branch = goal.branch.clone().ok_or_else(|| DesktopError::unsupported("this run has no branch of its own"))?;
        let source = goal.source_workspace_id.as_deref().and_then(|id| self.db(|storage| storage.workspace_get(id)).ok().flatten()).ok_or_else(|| DesktopError::not_ready("the checkout this run branched from is gone"))?;
        // Anything the last turn left uncommitted goes in first.
        if let Some(path) = goal.worktree_path.as_deref() {
            commit_checkpoint(Path::new(path), &format!("Big Thing: {}", goal.title));
        }
        let message = format!("Merge Big Thing run: {}", goal.title);
        let root = source.canonical_root.clone();
        let outcome = tokio::task::spawn_blocking(move || git::merge_branch(Path::new(&root), &branch, &message)).await.map_err(|_| DesktopError::io("the merge did not finish"))??;
        let summary = match &outcome {
            MergeOutcome::Merged { commit } => format!("Merged into the checkout it branched from ({})", &commit[..commit.len().min(10)]),
            MergeOutcome::UpToDate => "Nothing to merge: the checkout already has every commit".to_string(),
            MergeOutcome::Conflicts { files } => format!("The merge would conflict in {} file{}; nothing was changed", files.len(), if files.len() == 1 { "" } else { "s" }),
        };
        let detail = match &outcome {
            MergeOutcome::Conflicts { files } => Some(files.join("\n")),
            _ => None,
        };
        self.journal(goal_id, JournalKind::State, None, &summary, detail.as_deref());
        self.changed(goal_id);
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_branch_name_is_readable_and_unique_to_the_goal() {
        assert_eq!(branch_for("Ship onboarding v2!", "3f2a9b77"), "bigthing/ship-onboarding-v2-3f2a9b");
        assert_eq!(branch_for("???", "abc"), "bigthing/run-abc");
        assert!(git::valid_branch_name(&branch_for("A very long title with many many words", "0123456789")));
    }

    #[test]
    fn checkpoints_commit_and_a_rollback_drops_what_came_after() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let run = |args: &[&str]| std::process::Command::new("git").arg("-C").arg(root).args(args).output().map(|output| output.status.success()).unwrap_or(false);
        if !run(&["init", "-q", "-b", "main"]) {
            return;
        }
        std::fs::write(root.join("a.txt"), "one").unwrap();
        let first = commit_checkpoint(root, "first").expect("a commit");
        assert_eq!(commit_checkpoint(root, "nothing"), None, "nothing to commit");
        std::fs::write(root.join("a.txt"), "two").unwrap();
        std::fs::write(root.join("b.txt"), "new").unwrap();
        commit_checkpoint(root, "second").expect("a commit");
        std::fs::write(root.join("c.txt"), "untracked").unwrap();
        git::reset_hard(root, &first).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "one");
        assert!(!root.join("b.txt").exists() && !root.join("c.txt").exists());
        assert!(git::reset_hard(root, "--hard").is_err());
    }

    #[test]
    fn a_merge_lands_or_is_aborted_with_the_conflicts_named() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let run = |args: &[&str]| std::process::Command::new("git").arg("-C").arg(root).args(args).output().map(|output| output.status.success()).unwrap_or(false);
        if !run(&["init", "-q", "-b", "main"]) {
            return;
        }
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        commit_checkpoint(root, "base").unwrap();
        assert!(run(&["branch", "bigthing/run"]));
        let worktree = tempfile::tempdir().unwrap();
        let tree = worktree.path().join("run");
        assert!(run(&["worktree", "add", "-q", tree.to_str().unwrap(), "bigthing/run"]));
        std::fs::write(tree.join("b.txt"), "from the run\n").unwrap();
        commit_checkpoint(&tree, "run work").unwrap();
        assert!(matches!(git::merge_branch(root, "bigthing/run", "merge").unwrap(), MergeOutcome::Merged { .. }));
        assert_eq!(git::merge_branch(root, "bigthing/run", "merge").unwrap(), MergeOutcome::UpToDate);
        std::fs::write(tree.join("a.txt"), "run says\n").unwrap();
        commit_checkpoint(&tree, "run edit").unwrap();
        std::fs::write(root.join("a.txt"), "main says\n").unwrap();
        commit_checkpoint(root, "main edit").unwrap();
        assert_eq!(git::merge_branch(root, "bigthing/run", "merge").unwrap(), MergeOutcome::Conflicts { files: vec!["a.txt".into()] });
        assert!(git::is_clean(root).unwrap(), "an aborted merge leaves the checkout as it was");
    }
}
