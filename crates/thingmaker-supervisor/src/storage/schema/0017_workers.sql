-- Workers (docs/research/multi-provider-viability.md §2.2).
--
-- A session an orchestrator's `delegate` opened names the orchestrator's row
-- here, so the sidebar can show a worker under the session it works for and
-- a resume knows the session was never the user's own conversation.
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
