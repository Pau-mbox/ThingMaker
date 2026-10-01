//! The project's shared memory (ADR-010): decisions, conventions and facts
//! that the orchestrator, its workers and the user all read and write.
//!
//! Kept per project, not per checkout: a run in its own worktree writes to the
//! memory of the repository it branched from, so the next run finds it.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Storage, StorageError, new_id, now_unix_ms};

pub const MEMORY_KINDS: [&str; 5] = ["decision", "convention", "fact", "todo", "warning"];
const MAX_TITLE: usize = 160;
const MAX_BODY: usize = 4_000;
/// A memory of more entries than this is a database, not a memory; the
/// oldest are dropped from listings.
pub const MAX_LISTED: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub odyssey_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWrite {
    /// An existing entry to replace; absent writes a new one.
    #[serde(default)]
    pub id: Option<String>,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
}

const COLUMNS: &str = "id, workspace_id, kind, title, body, author, odyssey_id, created_at, updated_at";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryEntry> {
    Ok(MemoryEntry {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        body: row.get(4)?,
        author: row.get(5)?,
        odyssey_id: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn bounded(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit { text.to_string() } else { format!("{}…", text.chars().take(limit - 1).collect::<String>()) }
}

impl Storage {
    /// The workspace a memory belongs to: a managed worktree's is the
    /// repository it was made from.
    pub fn memory_workspace(&self, workspace_id: &str) -> Result<String, StorageError> {
        let Some(workspace) = self.workspace_get(workspace_id)? else { return Ok(workspace_id.to_string()) };
        let source: Option<String> = self
            .conn()
            .query_row("SELECT workspace_id FROM worktrees WHERE path = ?1 AND removed_at IS NULL", params![workspace.canonical_root], |row| row.get(0))
            .optional()?;
        Ok(source.unwrap_or_else(|| workspace_id.to_string()))
    }

    pub fn memory_list(&self, workspace_id: &str, query: Option<&str>) -> Result<Vec<MemoryEntry>, StorageError> {
        let workspace = self.memory_workspace(workspace_id)?;
        let mut statement = self.conn().prepare(&format!("SELECT {COLUMNS} FROM project_memory WHERE workspace_id = ?1 ORDER BY updated_at DESC LIMIT ?2"))?;
        let rows = statement.query_map(params![workspace, MAX_LISTED as i64], row)?;
        let mut entries = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        if let Some(query) = query.map(str::trim).filter(|query| !query.is_empty()) {
            let words: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_string).collect();
            entries.retain(|entry| {
                let haystack = format!("{} {} {}", entry.kind, entry.title, entry.body).to_lowercase();
                words.iter().all(|word| haystack.contains(word))
            });
        }
        Ok(entries)
    }

    pub fn memory_count(&self, workspace_id: &str) -> Result<usize, StorageError> {
        let workspace = self.memory_workspace(workspace_id)?;
        let count: i64 = self.conn().query_row("SELECT COUNT(*) FROM project_memory WHERE workspace_id = ?1", params![workspace], |row| row.get(0))?;
        Ok(count as usize)
    }

    pub fn memory_get(&self, id: &str) -> Result<Option<MemoryEntry>, StorageError> {
        Ok(self.conn().query_row(&format!("SELECT {COLUMNS} FROM project_memory WHERE id = ?1"), params![id], row).optional()?)
    }

    /// Writes an entry, or replaces one of the same project's.
    pub fn memory_write(&self, workspace_id: &str, write: &MemoryWrite, author: &str, odyssey_id: Option<&str>) -> Result<MemoryEntry, StorageError> {
        let workspace = self.memory_workspace(workspace_id)?;
        let kind = write.kind.trim().to_lowercase();
        if !MEMORY_KINDS.contains(&kind.as_str()) {
            return Err(StorageError::Invalid(format!("a memory is one of {}", MEMORY_KINDS.join(", "))));
        }
        let title = bounded(&write.title, MAX_TITLE);
        if title.is_empty() {
            return Err(StorageError::Invalid("a memory needs a title".into()));
        }
        let body = bounded(&write.body, MAX_BODY);
        let now = now_unix_ms();
        if let Some(id) = write.id.as_deref() {
            let existing = self.memory_get(id)?.ok_or_else(|| StorageError::NotFound(format!("memory {id} not found")))?;
            if existing.workspace_id != workspace {
                return Err(StorageError::Invalid("that memory belongs to another project".into()));
            }
            self.conn().execute(
                "UPDATE project_memory SET kind = ?2, title = ?3, body = ?4, author = ?5, updated_at = ?6 WHERE id = ?1",
                params![id, kind, title, body, author, now],
            )?;
            return self.memory_get(id)?.ok_or_else(|| StorageError::NotFound(format!("memory {id} not found")));
        }
        let id = new_id();
        self.conn().execute(
            "INSERT INTO project_memory (id, workspace_id, kind, title, body, author, odyssey_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![id, workspace, kind, title, body, author, odyssey_id, now],
        )?;
        self.memory_get(&id)?.ok_or_else(|| StorageError::NotFound(format!("memory {id} not found")))
    }

    pub fn memory_delete(&self, id: &str) -> Result<(), StorageError> {
        self.conn().execute("DELETE FROM project_memory WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_memory_is_written_found_replaced_and_kept_per_project() {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(&temp.path().join("t.db")).unwrap();
        let workspace = storage.workspace_upsert("/repo", "/repo", "h1").unwrap();
        let worktree = storage.workspace_upsert("/data/worktrees/h1/run", "run", "h2").unwrap();
        storage.worktree_insert(&workspace.id, "/data/worktrees/h1/run", "bigthing/run", "main").unwrap();
        let written = storage.memory_write(&worktree.id, &MemoryWrite { id: None, kind: "Decision".into(), title: "Use SQLite".into(), body: "for the cache".into() }, "claude", None).unwrap();
        assert_eq!(written.workspace_id, workspace.id, "a worktree writes to its repository's memory");
        assert_eq!(storage.memory_list(&workspace.id, Some("sqlite cache")).unwrap().len(), 1);
        assert!(storage.memory_list(&workspace.id, Some("postgres")).unwrap().is_empty());
        let replaced = storage.memory_write(&workspace.id, &MemoryWrite { id: Some(written.id.clone()), kind: "decision".into(), title: "Use Postgres".into(), body: String::new() }, "user", None).unwrap();
        assert_eq!(replaced.title, "Use Postgres");
        assert_eq!(storage.memory_count(&worktree.id).unwrap(), 1);
        assert!(storage.memory_write(&workspace.id, &MemoryWrite { id: None, kind: "gossip".into(), title: "x".into(), body: String::new() }, "user", None).is_err());
        storage.memory_delete(&written.id).unwrap();
        assert_eq!(storage.memory_count(&workspace.id).unwrap(), 0);
    }
}
