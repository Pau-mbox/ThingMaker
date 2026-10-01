-- ThingMaker desktop metadata, schema version 1 (spec section 15.1).
-- Each agent's own transcript remains canonical; nothing here duplicates it.
-- Timestamps are INTEGER milliseconds since the Unix epoch, UTC.

CREATE TABLE IF NOT EXISTS migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'isolated_local', 'remote')),
  label TEXT NOT NULL,
  -- Reference into secure storage; never a plaintext token.
  endpoint_ref TEXT,
  root_mapping TEXT,
  capability_digest TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO environments (id, kind, label, created_at)
VALUES ('local', 'local', 'This computer', 0);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  canonical_root TEXT NOT NULL,
  display_path TEXT NOT NULL,
  workspace_hash TEXT NOT NULL,
  trust_state TEXT NOT NULL DEFAULT 'untrusted'
    CHECK (trust_state IN ('untrusted', 'inspect_only', 'trusted_local')),
  -- Fingerprint of executable configuration reviewed at trust time (UX-02).
  trust_digest TEXT,
  trusted_at INTEGER,
  profile TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (environment_id, canonical_root)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_session_id TEXT NOT NULL,
  title_overlay TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('desktop', 'cli', 'unknown')),
  -- 'unavailable' marks catalog absence; canonical history is never deleted
  -- from absence alone (F12).
  archive_state TEXT NOT NULL DEFAULT 'active'
    CHECK (archive_state IN ('active', 'archived', 'unavailable')),
  pinned INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER,
  catalog_generation INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, agent_session_id)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  relative_blob_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  retention_state TEXT NOT NULL DEFAULT 'referenced'
    CHECK (retention_state IN ('referenced', 'orphaned', 'pinned')),
  created_at INTEGER NOT NULL,
  UNIQUE (content_hash)
);

CREATE TABLE drafts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  attachment_ids TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE submission_outbox (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  content_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('queued', 'writing', 'accepted', 'outcome_unknown', 'rejected')),
  -- Attachment generation as a decimal string (DecimalId).
  generation TEXT NOT NULL,
  message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_outbox_session_state ON submission_outbox (session_id, state);

CREATE TABLE projection_generations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  runtime_digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('building', 'active', 'stale', 'failed')),
  last_sequence TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL,
  activated_at INTEGER
);

CREATE UNIQUE INDEX idx_projection_active
  ON projection_generations (session_id) WHERE status = 'active';

CREATE TABLE settings (
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  typed_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, scope)
);
