//! Durable submission intent (spec section 8.6, 15.1).
//!
//! The outbox records what the user asked to send before the frame is
//! written. It does not provide exactly-once execution: the baseline wire has
//! no idempotency contract, so `outcome_unknown` entries are surfaced for
//! explicit user resubmission and never resent automatically (V08).

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Storage, StorageError, now_unix_ms};
use crate::{ids::DecimalId, supervisor::SubmissionState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxRecord {
    pub request_id: String,
    pub session_id: String,
    pub content_hash: String,
    pub payload_ref: String,
    pub state: SubmissionState,
    pub generation: DecimalId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Storage {
    /// Records a new submission in `queued` state.
    pub fn outbox_insert(
        &self,
        request_id: &str,
        session_id: &str,
        content_hash: &str,
        payload_ref: &str,
        generation: DecimalId,
    ) -> Result<OutboxRecord, StorageError> {
        let now = now_unix_ms();
        self.conn().execute(
            "INSERT INTO submission_outbox (request_id, session_id, content_hash, payload_ref, state, generation, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?6)",
            params![request_id, session_id, content_hash, payload_ref, generation.to_string(), now],
        )?;
        Ok(OutboxRecord {
            request_id: request_id.into(),
            session_id: session_id.into(),
            content_hash: content_hash.into(),
            payload_ref: payload_ref.into(),
            state: SubmissionState::Queued,
            generation,
            message: None,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn outbox_get(&self, request_id: &str) -> Result<Option<OutboxRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT request_id, session_id, content_hash, payload_ref, state, generation, message, created_at, updated_at
                 FROM submission_outbox WHERE request_id = ?1",
                params![request_id],
                row_to_record,
            )
            .optional()?)
    }

    /// Applies a legal transition. Returns `Conflict` for illegal ones so a
    /// bug can never turn an uncertain write back into a resendable one.
    pub fn outbox_transition(
        &self,
        request_id: &str,
        to: SubmissionState,
        message: Option<&str>,
    ) -> Result<OutboxRecord, StorageError> {
        let current = self
            .outbox_get(request_id)?
            .ok_or_else(|| StorageError::NotFound(format!("outbox entry {request_id} not found")))?;
        if !current.state.can_transition_to(to) {
            return Err(StorageError::Conflict(format!(
                "outbox entry {request_id} cannot move from {} to {}",
                current.state.as_str(),
                to.as_str()
            )));
        }
        let now = now_unix_ms();
        self.conn().execute(
            "UPDATE submission_outbox SET state = ?2, message = ?3, updated_at = ?4 WHERE request_id = ?1",
            params![request_id, to.as_str(), message, now],
        )?;
        Ok(OutboxRecord {
            state: to,
            message: message.map(str::to_string),
            updated_at: now,
            ..current
        })
    }

    /// Uncertain entries for every session of a workspace (desktop restart
    /// review, REC-01).
    pub fn outbox_uncertain_for_workspace(&self, workspace_id: &str) -> Result<Vec<OutboxRecord>, StorageError> {
        let mut statement = self.conn().prepare(
            "SELECT o.request_id, o.session_id, o.content_hash, o.payload_ref, o.state, o.generation, o.message, o.created_at, o.updated_at
             FROM submission_outbox o JOIN sessions s ON s.id = o.session_id
             WHERE s.workspace_id = ?1 AND o.state IN ('queued', 'writing', 'outcome_unknown') ORDER BY o.created_at",
        )?;
        let rows = statement.query_map(params![workspace_id], row_to_record)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Entries whose acceptance could not be established. Shown to the user
    /// for explicit review; never resent automatically.
    pub fn outbox_uncertain(&self, session_id: &str) -> Result<Vec<OutboxRecord>, StorageError> {
        let mut statement = self.conn().prepare(
            "SELECT request_id, session_id, content_hash, payload_ref, state, generation, message, created_at, updated_at
             FROM submission_outbox WHERE session_id = ?1 AND state IN ('writing', 'outcome_unknown')
             ORDER BY created_at",
        )?;
        let rows = statement.query_map(params![session_id], row_to_record)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutboxRecord> {
    let state: String = row.get(4)?;
    let generation: String = row.get(5)?;
    Ok(OutboxRecord {
        request_id: row.get(0)?,
        session_id: row.get(1)?,
        content_hash: row.get(2)?,
        payload_ref: row.get(3)?,
        state: SubmissionState::parse(&state).unwrap_or(SubmissionState::OutcomeUnknown),
        generation: DecimalId(generation.parse().unwrap_or_default()),
        message: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::workspaces::{SessionOrigin, TrustState};

    fn seeded() -> (Storage, String) {
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .workspace_upsert("/tmp/project", "/tmp/project", "w-abc")
            .unwrap();
        storage
            .workspace_set_trust(&workspace.id, TrustState::TrustedLocal, Some("digest"))
            .unwrap();
        let session = storage
            .session_upsert(&workspace.id, "s-1", SessionOrigin::Desktop, crate::agents::Provider::Claude)
            .unwrap();
        (storage, session.id)
    }

    #[test]
    fn outbox_follows_legal_transitions_and_refuses_illegal_ones() {
        let (storage, session) = seeded();
        let record = storage
            .outbox_insert("req-1", &session, "hash", "blob/req-1", DecimalId(1))
            .unwrap();
        assert_eq!(record.state, SubmissionState::Queued);
        storage.outbox_transition("req-1", SubmissionState::Writing, None).unwrap();
        let uncertain = storage.outbox_uncertain(&session).unwrap();
        assert_eq!(uncertain.len(), 1);
        storage
            .outbox_transition("req-1", SubmissionState::OutcomeUnknown, Some("timeout"))
            .unwrap();
        let error = storage
            .outbox_transition("req-1", SubmissionState::Writing, None)
            .unwrap_err();
        assert!(matches!(error, StorageError::Conflict(_)));
        let error = storage
            .outbox_transition("req-1", SubmissionState::Queued, None)
            .unwrap_err();
        assert!(matches!(error, StorageError::Conflict(_)));
        storage
            .outbox_transition("req-1", SubmissionState::Accepted, None)
            .unwrap();
        assert!(storage.outbox_uncertain(&session).unwrap().is_empty());
        assert!(matches!(
            storage.outbox_transition("missing", SubmissionState::Writing, None).unwrap_err(),
            StorageError::NotFound(_)
        ));
        let stored = storage.outbox_get("req-1").unwrap().unwrap();
        assert_eq!(stored.generation, DecimalId(1));
        assert_eq!(stored.state, SubmissionState::Accepted);
    }
}
