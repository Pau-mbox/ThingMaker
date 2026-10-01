-- Schema version 4: artifact versions (ART-01). Bytes live content-addressed
-- under <data_dir>/artifacts/<hash>; rows are versioned references.

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  environment_id TEXT NOT NULL DEFAULT 'local' REFERENCES environments(id),
  agent_session_id TEXT,
  call_id TEXT,
  logical_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  viewer TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('runtime_reported', 'observed')),
  source_path TEXT NOT NULL,
  previous_id TEXT REFERENCES artifacts(id),
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX artifacts_by_path ON artifacts(workspace_id, agent_session_id, logical_path, version);
