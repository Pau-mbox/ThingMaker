-- Forks and side sessions: copies of a session, listed under it. Their rows
-- say so in `origin`, which the CHECK constraint did not allow.
--
-- SQLite cannot change a CHECK constraint in place, so the sessions table is
-- rebuilt (the documented 12-step procedure; the runner turns foreign-key
-- enforcement off around this migration and checks every reference after).
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_session_id TEXT NOT NULL,
  title_overlay TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('desktop', 'cli', 'unknown', 'side', 'fork')),
  -- 'unavailable' marks a session whose transcript is gone; canonical history
  -- is never deleted from absence alone (F12).
  archive_state TEXT NOT NULL DEFAULT 'active'
    CHECK (archive_state IN ('active', 'archived', 'unavailable')),
  pinned INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER,
  catalog_generation INTEGER,
  created_at INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude', 'codex', 'gemini')),
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  auto_title TEXT,
  UNIQUE (workspace_id, agent_session_id)
);

INSERT INTO sessions_new (id, workspace_id, agent_session_id, title_overlay, origin, archive_state, pinned, last_seen, catalog_generation, created_at, provider, parent_session_id, auto_title)
  SELECT id, workspace_id, agent_session_id, title_overlay, origin, archive_state, pinned, last_seen, catalog_generation, created_at, provider, parent_session_id, auto_title FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

-- A session is often looked up by the agent's id alone, in any workspace.
CREATE INDEX sessions_by_agent_id ON sessions(agent_session_id);
