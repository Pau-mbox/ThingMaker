-- Desktop-managed worktrees (GIT-01..04). Worktrees live outside the repository
-- under the application data directory; each becomes its own workspace root.

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  path TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);

CREATE INDEX idx_worktrees_workspace ON worktrees (workspace_id, created_at DESC);
