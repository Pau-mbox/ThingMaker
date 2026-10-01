//! The notes an Odyssey run keeps in the workspace
//! (docs/research/odyssey-review.md §3.3, §2.3).
//!
//! Two files the agent writes and the runner only reads:
//!
//! * `docs/odyssey/STATE.md` — the handoff note: what is done, what is in
//!   flight, which files it owns, what it learned that the plan does not say.
//!   The transcript compacts and a session can be replaced; this is what a
//!   cold session or a subagent starts from.
//! * `docs/odyssey/agents/<name>.md` — a subagent's result, written before it
//!   returns. Half the subagent spend on the first run went into agents that
//!   died at a quota wall with their result in memory; a note on disk is what
//!   the next turn recovers instead of redoing the work.
//!
//! The desktop never writes these. It reports whether they exist and when
//! they changed, so the prompt can say "update it" or "create it" truthfully
//! and the screen can show the run's memory is being kept.

use std::{fs, path::Path, time::UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::DesktopError;

/// Workspace-relative path of the handoff note.
pub const STATE_NOTE_PATH: &str = "docs/odyssey/STATE.md";
/// Workspace-relative directory subagents write their results into.
pub const AGENT_NOTES_DIR: &str = "docs/odyssey/agents";

/// Notes listed per read; a folder of more than this is a folder, not notes.
const MAX_AGENT_NOTES: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInfo {
    /// Workspace-relative, forward slashes.
    pub path: String,
    pub bytes: u64,
    pub modified_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNotes {
    /// The handoff note, when it exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<NoteInfo>,
    /// Subagent notes, newest first.
    pub agent_notes: Vec<NoteInfo>,
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn info(root: &Path, relative: &str) -> Option<NoteInfo> {
    let metadata = fs::metadata(root.join(relative)).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(NoteInfo { path: relative.to_string(), bytes: metadata.len(), modified_at_unix_ms: modified_ms(&metadata) })
}

/// What the run has written to the workspace so far.
pub fn read_notes(root: &Path) -> Result<WorkspaceNotes, DesktopError> {
    let state = info(root, STATE_NOTE_PATH);
    let mut agent_notes = Vec::new();
    if let Ok(entries) = fs::read_dir(root.join(AGENT_NOTES_DIR)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".md") || name.starts_with('.') {
                continue;
            }
            if let Some(note) = info(root, &format!("{AGENT_NOTES_DIR}/{name}")) {
                agent_notes.push(note);
            }
        }
    }
    agent_notes.sort_by(|a, b| b.modified_at_unix_ms.cmp(&a.modified_at_unix_ms).then_with(|| a.path.cmp(&b.path)));
    agent_notes.truncate(MAX_AGENT_NOTES);
    Ok(WorkspaceNotes { state, agent_notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_with_no_notes_reads_as_none_not_as_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let notes = read_notes(temp.path()).unwrap();
        assert_eq!(notes.state, None);
        assert!(notes.agent_notes.is_empty());
    }

    #[test]
    fn the_handoff_note_and_agent_notes_are_found_with_their_ages() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("docs/odyssey/agents")).unwrap();
        fs::write(temp.path().join("docs/odyssey/STATE.md"), "# State\n").unwrap();
        fs::write(temp.path().join("docs/odyssey/agents/economy.md"), "done").unwrap();
        fs::write(temp.path().join("docs/odyssey/agents/notes.txt"), "not a note").unwrap();
        fs::write(temp.path().join("docs/odyssey/agents/.hidden.md"), "no").unwrap();
        let notes = read_notes(temp.path()).unwrap();
        let state = notes.state.expect("the handoff note");
        assert_eq!(state.path, STATE_NOTE_PATH);
        assert_eq!(state.bytes, 8);
        assert!(state.modified_at_unix_ms > 0);
        assert_eq!(notes.agent_notes.iter().map(|note| note.path.as_str()).collect::<Vec<_>>(), ["docs/odyssey/agents/economy.md"]);
    }

    #[test]
    fn a_directory_named_like_the_note_is_not_a_note() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("docs/odyssey/STATE.md")).unwrap();
        assert_eq!(read_notes(temp.path()).unwrap().state, None);
    }
}
