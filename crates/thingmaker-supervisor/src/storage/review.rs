//! Baseline records (REV-02). Manifests are stored as JSON; blobs live in the
//! content-addressed store.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Storage, StorageError, new_id, now_unix_ms};
use crate::review::BaselineManifest;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineRecord {
    pub id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    pub manifest_hash: String,
    pub file_count: usize,
    pub omitted_count: usize,
    pub created_at: i64,
}

const COLUMNS: &str = "id, workspace_id, session_id, scope, base_ref, manifest_hash, file_count, omitted_count, created_at";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BaselineRecord> {
    Ok(BaselineRecord {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        session_id: row.get(2)?,
        scope: row.get(3)?,
        base_ref: row.get(4)?,
        manifest_hash: row.get(5)?,
        file_count: row.get::<_, i64>(6)? as usize,
        omitted_count: row.get::<_, i64>(7)? as usize,
        created_at: row.get(8)?,
    })
}

impl Storage {
    pub fn baseline_insert(
        &self,
        workspace_id: &str,
        session_id: Option<&str>,
        scope: &str,
        base_ref: Option<&str>,
        manifest: &BaselineManifest,
    ) -> Result<BaselineRecord, StorageError> {
        let id = new_id();
        let json = serde_json::to_string(manifest).map_err(|e| StorageError::Invalid(e.to_string()))?;
        let now = now_unix_ms();
        let manifest_hash = manifest.manifest_hash();
        self.conn().execute(
            "INSERT INTO review_baselines (id, workspace_id, session_id, scope, base_ref, manifest, manifest_hash, file_count, omitted_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, workspace_id, session_id, scope, base_ref, json, manifest_hash, manifest.files.len() as i64, manifest.omitted as i64, now],
        )?;
        Ok(BaselineRecord {
            id,
            workspace_id: workspace_id.into(),
            session_id: session_id.map(str::to_string),
            scope: scope.into(),
            base_ref: base_ref.map(str::to_string),
            manifest_hash,
            file_count: manifest.files.len(),
            omitted_count: manifest.omitted,
            created_at: now,
        })
    }

    pub fn baseline_get(&self, id: &str) -> Result<Option<(BaselineRecord, BaselineManifest)>, StorageError> {
        let found: Option<(BaselineRecord, String)> = self
            .conn()
            .query_row(
                &format!("SELECT {COLUMNS}, manifest FROM review_baselines WHERE id = ?1"),
                params![id],
                |r| Ok((row(r)?, r.get::<_, String>(9)?)),
            )
            .optional()?;
        match found {
            None => Ok(None),
            Some((record, json)) => {
                let manifest = serde_json::from_str(&json).map_err(|e| StorageError::Invalid(format!("baseline manifest: {e}")))?;
                Ok(Some((record, manifest)))
            }
        }
    }

    /// Newest baseline for a workspace, optionally restricted to a session.
    pub fn baseline_latest(&self, workspace_id: &str, session_id: Option<&str>) -> Result<Option<BaselineRecord>, StorageError> {
        Ok(match session_id {
            Some(session) => self
                .conn()
                .query_row(
                    &format!("SELECT {COLUMNS} FROM review_baselines WHERE workspace_id = ?1 AND session_id = ?2 ORDER BY created_at DESC LIMIT 1"),
                    params![workspace_id, session],
                    row,
                )
                .optional()?,
            None => self
                .conn()
                .query_row(
                    &format!("SELECT {COLUMNS} FROM review_baselines WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT 1"),
                    params![workspace_id],
                    row,
                )
                .optional()?,
        })
    }

    pub fn baseline_list(&self, workspace_id: &str, limit: usize) -> Result<Vec<BaselineRecord>, StorageError> {
        let mut statement = self
            .conn()
            .prepare(&format!("SELECT {COLUMNS} FROM review_baselines WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2"))?;
        let rows = statement.query_map(params![workspace_id, limit as i64], row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::{BlobStore, capture_baseline};

    #[test]
    fn baselines_round_trip_with_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let blob_dir = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("f.txt"), "x\n").unwrap();
        let blobs = BlobStore::new(blob_dir.path());
        let manifest = capture_baseline(temp.path(), &blobs).unwrap();
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();
        assert!(storage.baseline_latest(&workspace.id, None).unwrap().is_none());
        let record = storage.baseline_insert(&workspace.id, None, "session_baseline", Some("main"), &manifest).unwrap();
        assert_eq!(record.file_count, 1, "{:?}", manifest.files.keys());
        let (loaded, loaded_manifest) = storage.baseline_get(&record.id).unwrap().unwrap();
        assert_eq!(loaded, record);
        assert_eq!(loaded_manifest, manifest);
        assert_eq!(storage.baseline_latest(&workspace.id, None).unwrap().unwrap().id, record.id);
        assert_eq!(storage.baseline_list(&workspace.id, 10).unwrap().len(), 1);
    }
}
