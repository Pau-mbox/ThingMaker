//! Workspace and session metadata records (UX-02, UX-03, F12).

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Storage, StorageError, new_id, now_unix_ms};
use crate::agents::Provider;

pub const LOCAL_ENVIRONMENT_ID: &str = "local";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustState {
    Untrusted,
    InspectOnly,
    TrustedLocal,
}

impl TrustState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Untrusted => "untrusted",
            Self::InspectOnly => "inspect_only",
            Self::TrustedLocal => "trusted_local",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "inspect_only" => Self::InspectOnly,
            "trusted_local" => Self::TrustedLocal,
            _ => Self::Untrusted,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub environment_id: String,
    pub canonical_root: String,
    pub display_path: String,
    /// Stable hash of the canonical root; keys the workspace's worktree
    /// directory (`workspace::identity`).
    pub workspace_hash: String,
    pub trust_state: TrustState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionOrigin {
    Desktop,
    Cli,
    Unknown,
}

impl SessionOrigin {
    fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Cli => "cli",
            Self::Unknown => "unknown",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "desktop" => Self::Desktop,
            "cli" => Self::Cli,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveState {
    Active,
    Archived,
    /// The agent no longer has the session (its transcript is gone); a
    /// reversible index tombstone, not a deletion.
    Unavailable,
}

impl ArchiveState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
            Self::Unavailable => "unavailable",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "archived" => Self::Archived,
            "unavailable" => Self::Unavailable,
            _ => Self::Active,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub workspace_id: String,
    /// The agent's own id for the session.
    pub agent_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_overlay: Option<String>,
    pub origin: SessionOrigin,
    pub archive_state: ArchiveState,
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<i64>,
    /// The provider this session runs on. It decides the launch contract,
    /// where the transcript lives and which account the work is charged to,
    /// so it is a property of the row rather than re-derived on each open.
    pub provider: Provider,
    /// The orchestrator's row, for a worker session a `delegate` opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    pub created_at: i64,
}

const WORKSPACE_COLUMNS: &str =
    "id, environment_id, canonical_root, display_path, workspace_hash, trust_state, trust_digest, trusted_at, created_at";

fn row_to_workspace(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRecord> {
    let trust: String = row.get(5)?;
    Ok(WorkspaceRecord {
        id: row.get(0)?,
        environment_id: row.get(1)?,
        canonical_root: row.get(2)?,
        display_path: row.get(3)?,
        workspace_hash: row.get(4)?,
        trust_state: TrustState::parse(&trust),
        trust_digest: row.get(6)?,
        trusted_at: row.get(7)?,
        created_at: row.get(8)?,
    })
}

const SESSION_COLUMNS: &str =
    "id, workspace_id, agent_session_id, title_overlay, origin, archive_state, pinned, last_seen, created_at, provider, parent_session_id";

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    let origin: String = row.get(4)?;
    let archive: String = row.get(5)?;
    let pinned: i64 = row.get(6)?;
    Ok(SessionRecord {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        agent_session_id: row.get(2)?,
        title_overlay: row.get(3)?,
        origin: SessionOrigin::parse(&origin),
        archive_state: ArchiveState::parse(&archive),
        pinned: pinned != 0,
        last_seen: row.get(7)?,
        created_at: row.get(8)?,
        // The CHECK constraint admits only known providers.
        provider: Provider::parse(&row.get::<_, String>(9)?).unwrap_or_default(),
        parent_session_id: row.get(10)?,
    })
}

impl Storage {
    /// Finds or creates the local-environment workspace for a canonical root.
    pub fn workspace_upsert(
        &self,
        canonical_root: &str,
        display_path: &str,
        workspace_hash: &str,
    ) -> Result<WorkspaceRecord, StorageError> {
        if let Some(existing) = self.workspace_by_root(canonical_root)? {
            return Ok(existing);
        }
        let id = new_id();
        let now = now_unix_ms();
        self.conn().execute(
            "INSERT INTO workspaces (id, environment_id, canonical_root, display_path, workspace_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, LOCAL_ENVIRONMENT_ID, canonical_root, display_path, workspace_hash, now],
        )?;
        Ok(WorkspaceRecord {
            id,
            environment_id: LOCAL_ENVIRONMENT_ID.into(),
            canonical_root: canonical_root.into(),
            display_path: display_path.into(),
            workspace_hash: workspace_hash.into(),
            trust_state: TrustState::Untrusted,
            trust_digest: None,
            trusted_at: None,
            created_at: now,
        })
    }

    pub fn workspace_by_root(&self, canonical_root: &str) -> Result<Option<WorkspaceRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE environment_id = ?1 AND canonical_root = ?2"),
                params![LOCAL_ENVIRONMENT_ID, canonical_root],
                row_to_workspace,
            )
            .optional()?)
    }

    pub fn workspace_get(&self, id: &str) -> Result<Option<WorkspaceRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1"),
                params![id],
                row_to_workspace,
            )
            .optional()?)
    }

    /// Removes a workspace and every desktop record that hangs off it
    /// (sessions, drafts, outbox rows, projection generations, baselines,
    /// artifacts, worktree records). The agents' own transcripts and the files on
    /// disk are untouched: this only forgets the workspace in the desktop.
    pub fn workspace_delete(&self, id: &str) -> Result<(), StorageError> {
        let conn = self.conn();
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<(), StorageError> {
            conn.execute("DELETE FROM projection_generations WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)", params![id])?;
            conn.execute("DELETE FROM submission_outbox WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)", params![id])?;
            conn.execute("DELETE FROM drafts WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)", params![id])?;
            conn.execute("DELETE FROM review_baselines WHERE workspace_id = ?1", params![id])?;
            conn.execute("DELETE FROM artifacts WHERE workspace_id = ?1", params![id])?;
            conn.execute("DELETE FROM worktrees WHERE workspace_id = ?1", params![id])?;
            conn.execute("DELETE FROM sessions WHERE workspace_id = ?1", params![id])?;
            let removed = conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
            if removed == 0 {
                return Err(StorageError::NotFound(format!("workspace {id} not found")));
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT")?;
                Ok(())
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub fn workspace_list(&self) -> Result<Vec<WorkspaceRecord>, StorageError> {
        let mut statement = self
            .conn()
            .prepare(&format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces ORDER BY created_at DESC"))?;
        let rows = statement.query_map([], row_to_workspace)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Records a trust decision bound to the reviewed configuration digest.
    pub fn workspace_set_trust(
        &self,
        id: &str,
        state: TrustState,
        trust_digest: Option<&str>,
    ) -> Result<WorkspaceRecord, StorageError> {
        let trusted_at = if state == TrustState::Untrusted { None } else { Some(now_unix_ms()) };
        let changed = self.conn().execute(
            "UPDATE workspaces SET trust_state = ?2, trust_digest = ?3, trusted_at = ?4 WHERE id = ?1",
            params![id, state.as_str(), trust_digest, trusted_at],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("workspace {id} not found")));
        }
        self.workspace_get(id)?
            .ok_or_else(|| StorageError::NotFound(format!("workspace {id} not found")))
    }

    /// Finds or creates the desktop record for a session. An existing row
    /// keeps the provider it was created with: the transcript it already has
    /// was written by that program.
    pub fn session_upsert(
        &self,
        workspace_id: &str,
        agent_session_id: &str,
        origin: SessionOrigin,
        provider: Provider,
    ) -> Result<SessionRecord, StorageError> {
        if let Some(existing) = self.session_by_agent_id(workspace_id, agent_session_id)? {
            if existing.archive_state == ArchiveState::Unavailable {
                self.conn().execute(
                    "UPDATE sessions SET archive_state = 'active', last_seen = ?2 WHERE id = ?1",
                    params![existing.id, now_unix_ms()],
                )?;
                return Ok(SessionRecord {
                    archive_state: ArchiveState::Active,
                    ..existing
                });
            }
            return Ok(existing);
        }
        let id = new_id();
        let now = now_unix_ms();
        self.conn().execute(
            "INSERT INTO sessions (id, workspace_id, agent_session_id, origin, last_seen, created_at, provider)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
            params![id, workspace_id, agent_session_id, origin.as_str(), now, provider.as_str()],
        )?;
        Ok(SessionRecord {
            id,
            workspace_id: workspace_id.into(),
            agent_session_id: agent_session_id.into(),
            title_overlay: None,
            origin,
            archive_state: ArchiveState::Active,
            pinned: false,
            last_seen: Some(now),
            provider,
            parent_session_id: None,
            created_at: now,
        })
    }

    /// Marks a session as a worker of `parent` (both desktop row ids).
    pub fn session_set_parent(&self, id: &str, parent: Option<&str>) -> Result<(), StorageError> {
        self.conn().execute("UPDATE sessions SET parent_session_id = ?2 WHERE id = ?1", params![id, parent])?;
        Ok(())
    }

    pub fn session_by_agent_id(
        &self,
        workspace_id: &str,
        agent_session_id: &str,
    ) -> Result<Option<SessionRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE workspace_id = ?1 AND agent_session_id = ?2"),
                params![workspace_id, agent_session_id],
                row_to_session,
            )
            .optional()?)
    }

    /// Marks a session the last time the desktop saw it attached.
    pub fn session_touch(&self, id: &str) -> Result<(), StorageError> {
        self.conn()
            .execute("UPDATE sessions SET last_seen = ?2 WHERE id = ?1", params![id, now_unix_ms()])?;
        Ok(())
    }

    pub fn session_list(&self, workspace_id: &str) -> Result<Vec<SessionRecord>, StorageError> {
        let mut statement = self.conn().prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM sessions WHERE workspace_id = ?1 ORDER BY pinned DESC, last_seen DESC"
        ))?;
        let rows = statement.query_map(params![workspace_id], row_to_session)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn session_set_archive(&self, id: &str, state: ArchiveState) -> Result<(), StorageError> {
        let changed = self.conn().execute(
            "UPDATE sessions SET archive_state = ?2 WHERE id = ?1",
            params![id, state.as_str()],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("session {id} not found")));
        }
        Ok(())
    }

    /// Sets or clears the desktop's display name for a session. An overlay
    /// only: the agent's own transcript and session store are never written
    /// (ADR-006), so a rename here cannot desynchronise them.
    pub fn session_set_title_overlay(&self, id: &str, title: Option<&str>) -> Result<(), StorageError> {
        let trimmed = title.map(str::trim).filter(|value| !value.is_empty());
        let changed = self
            .conn()
            .execute("UPDATE sessions SET title_overlay = ?2 WHERE id = ?1", params![id, trimmed])?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("session {id} not found")));
        }
        Ok(())
    }

    /// Pins or unpins a session. Like the archive flag this is an index
    /// decision only: the agent's transcript is never touched (ADR-006). Pinned
    /// sessions already sort first in [`Self::session_list`].
    pub fn session_set_pinned(&self, id: &str, pinned: bool) -> Result<(), StorageError> {
        let changed = self
            .conn()
            .execute("UPDATE sessions SET pinned = ?2 WHERE id = ?1", params![id, pinned as i64])?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("session {id} not found")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspaces_are_unique_by_root_and_record_trust() {
        let storage = Storage::open_in_memory().unwrap();
        let first = storage.workspace_upsert("/p", "~/p", "w-1").unwrap();
        let again = storage.workspace_upsert("/p", "~/p", "w-1").unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(first.trust_state, TrustState::Untrusted);
        let trusted = storage
            .workspace_set_trust(&first.id, TrustState::TrustedLocal, Some("cfg-digest"))
            .unwrap();
        assert_eq!(trusted.trust_state, TrustState::TrustedLocal);
        assert!(trusted.trusted_at.is_some());
        assert_eq!(storage.workspace_list().unwrap().len(), 1);
        assert!(matches!(
            storage.workspace_set_trust("nope", TrustState::InspectOnly, None),
            Err(StorageError::NotFound(_))
        ));
    }

    #[test]
    fn pinning_sorts_a_session_first_without_touching_its_transcript_flags() {
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();
        let older = storage.session_upsert(&workspace.id, "old", SessionOrigin::Desktop, Provider::Claude).unwrap();
        let newer = storage.session_upsert(&workspace.id, "new", SessionOrigin::Desktop, Provider::Claude).unwrap();
        storage.session_touch(&newer.id).unwrap();
        assert!(storage.session_list(&workspace.id).unwrap().iter().all(|session| !session.pinned));

        storage.session_set_pinned(&older.id, true).unwrap();

        let listed = storage.session_list(&workspace.id).unwrap();
        assert_eq!(listed[0].agent_session_id, "old", "pinned sessions sort first");
        assert!(listed[0].pinned);
        assert_eq!(listed[0].archive_state, ArchiveState::Active, "pinning is not archiving");
        assert_eq!(listed.iter().filter(|session| session.pinned).count(), 1);

        storage.session_set_pinned(&older.id, false).unwrap();
        assert!(storage.session_list(&workspace.id).unwrap().iter().all(|session| !session.pinned));
        assert!(matches!(storage.session_set_pinned("nope", true), Err(StorageError::NotFound(_))));
    }

    #[test]
    fn renaming_stores_a_display_overlay_and_blank_clears_it() {
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();
        let session = storage.session_upsert(&workspace.id, "s-1", SessionOrigin::Desktop, Provider::Claude).unwrap();
        assert_eq!(session.title_overlay, None);

        storage.session_set_title_overlay(&session.id, Some("  Season 2 planning  ")).unwrap();
        let renamed = storage.session_by_agent_id(&workspace.id, "s-1").unwrap().unwrap();
        assert_eq!(renamed.title_overlay.as_deref(), Some("Season 2 planning"), "surrounding space is not part of a name");
        assert_eq!(renamed.agent_session_id, "s-1", "the rename is an overlay, not a new identity");

        // Blank means "no overlay", so the derived title comes back.
        storage.session_set_title_overlay(&session.id, Some("   ")).unwrap();
        assert_eq!(storage.session_by_agent_id(&workspace.id, "s-1").unwrap().unwrap().title_overlay, None);
        storage.session_set_title_overlay(&session.id, Some("Named")).unwrap();
        storage.session_set_title_overlay(&session.id, None).unwrap();
        assert_eq!(storage.session_by_agent_id(&workspace.id, "s-1").unwrap().unwrap().title_overlay, None);
        assert!(matches!(storage.session_set_title_overlay("nope", Some("x")), Err(StorageError::NotFound(_))));
    }

    #[test]
    fn a_session_keeps_the_provider_it_was_created_with_and_revives_from_a_tombstone() {
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();
        let created = storage
            .session_upsert(&workspace.id, "d847b2a3-c7b5-4459-8b0f-02fdd03031a4", SessionOrigin::Desktop, Provider::Claude)
            .unwrap();
        assert_eq!(created.provider, Provider::Claude);
        storage.session_set_archive(&created.id, ArchiveState::Unavailable).unwrap();
        let revived = storage
            .session_upsert(&workspace.id, "d847b2a3-c7b5-4459-8b0f-02fdd03031a4", SessionOrigin::Desktop, Provider::Claude)
            .unwrap();
        assert_eq!(revived.id, created.id, "record survives absence");
        assert_eq!(revived.archive_state, ArchiveState::Active);
    }

    #[test]
    fn workspace_delete_removes_dependent_records_but_not_others() {
        let storage = Storage::open_in_memory().unwrap();
        let keep = storage.workspace_upsert("/tmp/keep", "/tmp/keep", "w-keep").unwrap();
        let gone = storage.workspace_upsert("/tmp/gone", "/tmp/gone", "w-gone").unwrap();
        let session = storage.session_upsert(&gone.id, "s-1", SessionOrigin::Desktop, Provider::Claude).unwrap();
        storage.outbox_insert("req-1", &session.id, "h", "outbox/req-1.json", crate::ids::DecimalId(1)).unwrap();
        storage.session_upsert(&keep.id, "s-2", SessionOrigin::Desktop, Provider::Claude).unwrap();
        storage.workspace_delete(&gone.id).unwrap();
        assert!(storage.workspace_get(&gone.id).unwrap().is_none());
        assert!(storage.session_list(&gone.id).unwrap().is_empty());
        assert!(storage.outbox_get("req-1").unwrap().is_none());
        assert_eq!(storage.session_list(&keep.id).unwrap().len(), 1);
        assert!(matches!(storage.workspace_delete("missing").unwrap_err(), StorageError::NotFound(_)));
    }
}
