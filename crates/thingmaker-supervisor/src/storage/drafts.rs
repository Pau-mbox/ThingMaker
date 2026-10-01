//! Composer drafts with optimistic revisions (UX-05, section 15.1).

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Storage, StorageError, now_unix_ms};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub session_id: String,
    pub text: String,
    pub attachment_ids: Vec<String>,
    pub revision: i64,
    pub updated_at: i64,
}

impl Storage {
    pub fn draft_get(&self, session_id: &str) -> Result<Option<Draft>, StorageError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT session_id, text, attachment_ids, revision, updated_at FROM drafts WHERE session_id = ?1",
                params![session_id],
                |row| {
                    let attachments: String = row.get(2)?;
                    Ok(Draft {
                        session_id: row.get(0)?,
                        text: row.get(1)?,
                        attachment_ids: serde_json::from_str(&attachments).unwrap_or_default(),
                        revision: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    /// Saves a draft. `expected_revision` must match the stored revision (or
    /// be `None` for a first save); otherwise a `Conflict` is returned so two
    /// windows cannot silently overwrite each other.
    pub fn draft_save(
        &self,
        session_id: &str,
        text: &str,
        attachment_ids: &[String],
        expected_revision: Option<i64>,
    ) -> Result<Draft, StorageError> {
        let current = self.draft_get(session_id)?;
        let current_revision = current.as_ref().map(|draft| draft.revision);
        if current_revision != expected_revision {
            return Err(StorageError::Conflict(format!(
                "draft revision mismatch: expected {expected_revision:?}, stored {current_revision:?}"
            )));
        }
        let revision = current_revision.unwrap_or(0) + 1;
        let now = now_unix_ms();
        let attachments = serde_json::to_string(attachment_ids).unwrap_or_else(|_| "[]".into());
        self.conn().execute(
            "INSERT INTO drafts (session_id, text, attachment_ids, revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, attachment_ids = excluded.attachment_ids,
             revision = excluded.revision, updated_at = excluded.updated_at",
            params![session_id, text, attachments, revision, now],
        )?;
        Ok(Draft {
            session_id: session_id.into(),
            text: text.into(),
            attachment_ids: attachment_ids.to_vec(),
            revision,
            updated_at: now,
        })
    }

    pub fn draft_clear(&self, session_id: &str) -> Result<(), StorageError> {
        self.conn()
            .execute("DELETE FROM drafts WHERE session_id = ?1", params![session_id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::workspaces::SessionOrigin;

    #[test]
    fn drafts_use_optimistic_revisions() {
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();
        let session = storage
            .session_upsert(&workspace.id, "s-1", SessionOrigin::Desktop, crate::agents::Provider::Claude)
            .unwrap();
        assert!(storage.draft_get(&session.id).unwrap().is_none());
        let first = storage.draft_save(&session.id, "keep this", &[], None).unwrap();
        assert_eq!(first.revision, 1);
        let stale = storage.draft_save(&session.id, "other window", &[], None);
        assert!(matches!(stale, Err(StorageError::Conflict(_))));
        let second = storage
            .draft_save(&session.id, "keep this too", &["att-1".into()], Some(1))
            .unwrap();
        assert_eq!(second.revision, 2);
        assert_eq!(storage.draft_get(&session.id).unwrap().unwrap().attachment_ids, vec!["att-1"]);
        storage.draft_clear(&session.id).unwrap();
        assert!(storage.draft_get(&session.id).unwrap().is_none());
    }
}
