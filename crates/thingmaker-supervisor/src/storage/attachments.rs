//! Attachment metadata rows (section 15.1). Blobs live under
//! `<data_dir>/attachments/<hash>`; rows track mime, size and retention.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Storage, StorageError, now_unix_ms};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRecord {
    pub id: String,
    pub content_hash: String,
    pub relative_blob_path: String,
    pub mime: String,
    pub bytes: i64,
    pub retention_state: String,
    pub created_at: i64,
}

impl Storage {
    pub fn attachment_upsert(&self, id: &str, content_hash: &str, relative_blob_path: &str, mime: &str, bytes: i64) -> Result<(), StorageError> {
        self.conn().execute(
            "INSERT INTO attachments (id, content_hash, relative_blob_path, mime, bytes, retention_state, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'referenced', ?6)
             ON CONFLICT(id) DO UPDATE SET retention_state = 'referenced'",
            params![id, content_hash, relative_blob_path, mime, bytes, now_unix_ms()],
        )?;
        Ok(())
    }

    pub fn attachment_get(&self, id: &str) -> Result<Option<AttachmentRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT id, content_hash, relative_blob_path, mime, bytes, retention_state, created_at FROM attachments WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?)
    }

    pub fn attachment_list(&self) -> Result<Vec<AttachmentRecord>, StorageError> {
        let mut statement = self
            .conn()
            .prepare("SELECT id, content_hash, relative_blob_path, mime, bytes, retention_state, created_at FROM attachments ORDER BY created_at")?;
        let rows = statement.query_map([], row_to_record)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Attachment ids referenced by drafts or by outbox entries that are not
    /// settled; these can never be garbage-collected (section 15.2).
    pub fn attachment_referenced_ids(&self) -> Result<Vec<String>, StorageError> {
        let mut ids = Vec::new();
        let mut statement = self.conn().prepare("SELECT attachment_ids FROM drafts")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        for json in rows {
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&json?) {
                ids.extend(list);
            }
        }
        Ok(ids)
    }

    pub fn attachment_set_retention(&self, id: &str, state: &str) -> Result<(), StorageError> {
        self.conn()
            .execute("UPDATE attachments SET retention_state = ?2 WHERE id = ?1", params![id, state])?;
        Ok(())
    }

    pub fn attachment_delete(&self, id: &str) -> Result<(), StorageError> {
        self.conn().execute("DELETE FROM attachments WHERE id = ?1", params![id])?;
        Ok(())
    }
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttachmentRecord> {
    Ok(AttachmentRecord {
        id: row.get(0)?,
        content_hash: row.get(1)?,
        relative_blob_path: row.get(2)?,
        mime: row.get(3)?,
        bytes: row.get(4)?,
        retention_state: row.get(5)?,
        created_at: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachments_round_trip() {
        let storage = Storage::open_in_memory().unwrap();
        storage.attachment_upsert("h1", "h1", "attachments/h1", "image/png", 10).unwrap();
        storage.attachment_upsert("h1", "h1", "attachments/h1", "image/png", 10).unwrap();
        let listed = storage.attachment_list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(storage.attachment_get("h1").unwrap().unwrap().mime, "image/png");
        storage.attachment_set_retention("h1", "orphaned").unwrap();
        assert_eq!(storage.attachment_get("h1").unwrap().unwrap().retention_state, "orphaned");
        storage.attachment_delete("h1").unwrap();
        assert!(storage.attachment_get("h1").unwrap().is_none());
    }
}
