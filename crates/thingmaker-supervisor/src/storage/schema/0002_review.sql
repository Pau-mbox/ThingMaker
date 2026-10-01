-- Review baselines (spec section 15.1 `review_baselines`).
-- The manifest is a JSON document of path -> {hash, bytes, mode, content};
-- retained file bytes live in the private blob store, not in this database.

CREATE TABLE review_baselines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  session_id TEXT REFERENCES sessions(id),
  scope TEXT NOT NULL,
  base_ref TEXT,
  manifest TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  omitted_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_baselines_workspace ON review_baselines (workspace_id, created_at DESC);
