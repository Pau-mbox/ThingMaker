//! Desktop-managed worktree records (GIT-04: pinned worktrees are exempt from
//! cleanup; removal is recorded, never silent).

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Storage, StorageError, new_id, now_unix_ms};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub id: String,
    pub workspace_id: String,
    pub path: String,
    pub branch: String,
    pub base_ref: String,
    pub pinned: bool,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_at: Option<i64>,
}

const COLUMNS: &str = "id, workspace_id, path, branch, base_ref, pinned, created_at, removed_at";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorktreeRecord> {
    Ok(WorktreeRecord {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        path: row.get(2)?,
        branch: row.get(3)?,
        base_ref: row.get(4)?,
        pinned: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        removed_at: row.get(7)?,
    })
}

impl Storage {
    pub fn worktree_insert(&self, workspace_id: &str, path: &str, branch: &str, base_ref: &str) -> Result<WorktreeRecord, StorageError> {
        let id = new_id();
        let now = now_unix_ms();
        self.conn().execute(
            "INSERT INTO worktrees (id, workspace_id, path, branch, base_ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, workspace_id, path, branch, base_ref, now],
        )?;
        Ok(WorktreeRecord {
            id,
            workspace_id: workspace_id.into(),
            path: path.into(),
            branch: branch.into(),
            base_ref: base_ref.into(),
            pinned: false,
            created_at: now,
            removed_at: None,
        })
    }

    pub fn worktree_list(&self, workspace_id: &str) -> Result<Vec<WorktreeRecord>, StorageError> {
        let mut statement = self
            .conn()
            .prepare(&format!("SELECT {COLUMNS} FROM worktrees WHERE workspace_id = ?1 AND removed_at IS NULL ORDER BY created_at DESC"))?;
        let rows = statement.query_map(params![workspace_id], row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn worktree_by_path(&self, path: &str) -> Result<Option<WorktreeRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT {COLUMNS} FROM worktrees WHERE path = ?1"), params![path], row)
            .optional()?)
    }

    pub fn worktree_set_pinned(&self, id: &str, pinned: bool) -> Result<(), StorageError> {
        let changed = self
            .conn()
            .execute("UPDATE worktrees SET pinned = ?2 WHERE id = ?1", params![id, pinned as i64])?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("worktree {id} not found")));
        }
        Ok(())
    }

    pub fn worktree_mark_removed(&self, id: &str) -> Result<(), StorageError> {
        self.conn()
            .execute("UPDATE worktrees SET removed_at = ?2 WHERE id = ?1", params![id, now_unix_ms()])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_records_track_pins_and_removal() {
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();
        let record = storage.worktree_insert(&workspace.id, "/wt/a", "feature/a", "main").unwrap();
        assert_eq!(storage.worktree_list(&workspace.id).unwrap().len(), 1);
        storage.worktree_set_pinned(&record.id, true).unwrap();
        assert!(storage.worktree_by_path("/wt/a").unwrap().unwrap().pinned);
        assert!(storage.worktree_insert(&workspace.id, "/wt/a", "x", "main").is_err(), "path unique");
        storage.worktree_mark_removed(&record.id).unwrap();
        assert!(storage.worktree_list(&workspace.id).unwrap().is_empty());
        assert!(storage.worktree_by_path("/wt/a").unwrap().unwrap().removed_at.is_some());
    }
}
