//! Artifact version rows (ART-01).

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Storage, StorageError, now_unix_ms};
use crate::artifacts::{Provenance, Viewer};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub id: String,
    pub workspace_id: String,
    pub environment_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    pub logical_path: String,
    pub mime: String,
    pub viewer: Viewer,
    pub content_hash: String,
    pub bytes: i64,
    pub provenance: Provenance,
    pub source_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_id: Option<String>,
    pub version: i64,
    pub created_at: i64,
}

pub struct NewArtifact<'a> {
    pub workspace_id: &'a str,
    pub agent_session_id: Option<&'a str>,
    pub call_id: Option<&'a str>,
    pub logical_path: &'a str,
    pub mime: &'a str,
    pub viewer: Viewer,
    pub content_hash: &'a str,
    pub bytes: i64,
    pub provenance: Provenance,
    pub source_path: &'a str,
}

const COLUMNS: &str = "id, workspace_id, environment_id, agent_session_id, call_id, logical_path, mime, viewer, content_hash, bytes, provenance, source_path, previous_id, version, created_at";

impl Storage {
    pub fn artifact_latest(&self, workspace_id: &str, agent_session_id: Option<&str>, logical_path: &str) -> Result<Option<ArtifactRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM artifacts WHERE workspace_id = ?1 AND agent_session_id IS ?2 AND logical_path = ?3 ORDER BY version DESC LIMIT 1"
                ),
                params![workspace_id, agent_session_id, logical_path],
                row_to_record,
            )
            .optional()?)
    }

    /// Records a version only when the content differs from the latest one
    /// for the same logical path; returns the current record either way.
    pub fn artifact_record_version(&self, new: NewArtifact<'_>) -> Result<(ArtifactRecord, bool), StorageError> {
        let latest = self.artifact_latest(new.workspace_id, new.agent_session_id, new.logical_path)?;
        if let Some(latest) = &latest
            && latest.content_hash == new.content_hash
        {
            return Ok((latest.clone(), false));
        }
        let version = latest.as_ref().map_or(1, |l| l.version + 1);
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_unix_ms();
        self.conn().execute(
            &format!("INSERT INTO artifacts ({COLUMNS}) VALUES (?1, ?2, 'local', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"),
            params![
                id,
                new.workspace_id,
                new.agent_session_id,
                new.call_id,
                new.logical_path,
                new.mime,
                new.viewer.as_str(),
                new.content_hash,
                new.bytes,
                new.provenance.as_str(),
                new.source_path,
                latest.as_ref().map(|l| l.id.clone()),
                version,
                now
            ],
        )?;
        let record = self.artifact_get(&id)?.ok_or_else(|| StorageError::NotFound("artifact just inserted is missing".into()))?;
        Ok((record, true))
    }

    pub fn artifact_get(&self, id: &str) -> Result<Option<ArtifactRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT {COLUMNS} FROM artifacts WHERE id = ?1"), params![id], row_to_record)
            .optional()?)
    }

    /// All versions for a workspace (optionally one session), newest first.
    pub fn artifact_list(&self, workspace_id: &str, agent_session_id: Option<&str>, limit: usize) -> Result<Vec<ArtifactRecord>, StorageError> {
        let mut statement = self.conn().prepare(&format!(
            "SELECT {COLUMNS} FROM artifacts WHERE workspace_id = ?1 AND (?2 IS NULL OR agent_session_id IS ?2) ORDER BY created_at DESC, version DESC LIMIT ?3"
        ))?;
        let rows = statement.query_map(params![workspace_id, agent_session_id, limit as i64], row_to_record)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn artifact_hashes_in_use(&self) -> Result<Vec<String>, StorageError> {
        let mut statement = self.conn().prepare("SELECT DISTINCT content_hash FROM artifacts")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtifactRecord> {
    let viewer: String = row.get(7)?;
    let provenance: String = row.get(10)?;
    Ok(ArtifactRecord {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        environment_id: row.get(2)?,
        agent_session_id: row.get(3)?,
        call_id: row.get(4)?,
        logical_path: row.get(5)?,
        mime: row.get(6)?,
        viewer: Viewer::parse(&viewer),
        content_hash: row.get(8)?,
        bytes: row.get(9)?,
        provenance: Provenance::parse(&provenance).unwrap_or(Provenance::Observed),
        source_path: row.get(11)?,
        previous_id: row.get(12)?,
        version: row.get(13)?,
        created_at: row.get(14)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_chain_and_identical_content_is_not_duplicated() {
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/tmp/p", "/tmp/p", "w-x").unwrap();
        let new = |hash: &'static str| NewArtifact {
            workspace_id: &workspace.id,
            agent_session_id: Some("kw-1"),
            call_id: None,
            logical_path: "out/report.md",
            mime: "text/markdown",
            viewer: Viewer::Markdown,
            content_hash: hash,
            bytes: 3,
            provenance: Provenance::Observed,
            source_path: "/tmp/p/out/report.md",
        };
        let (v1, inserted) = storage.artifact_record_version(new("h1")).unwrap();
        assert!(inserted);
        assert_eq!(v1.version, 1);
        let (same, inserted) = storage.artifact_record_version(new("h1")).unwrap();
        assert!(!inserted);
        assert_eq!(same.id, v1.id);
        let (v2, inserted) = storage.artifact_record_version(new("h2")).unwrap();
        assert!(inserted);
        assert_eq!(v2.version, 2);
        assert_eq!(v2.previous_id.as_deref(), Some(v1.id.as_str()));
        let listed = storage.artifact_list(&workspace.id, Some("kw-1"), 10).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(storage.artifact_list(&workspace.id, None, 10).unwrap().len(), 2);
        assert_eq!(storage.artifact_hashes_in_use().unwrap().len(), 2);
    }
}
