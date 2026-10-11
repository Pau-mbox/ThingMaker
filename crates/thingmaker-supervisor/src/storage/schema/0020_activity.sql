-- Derived Chill presentation metadata; canonical transcripts remain provider-owned.
CREATE TABLE activity_files (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  touched_at INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path)
);
CREATE INDEX activity_files_recent ON activity_files(touched_at);
