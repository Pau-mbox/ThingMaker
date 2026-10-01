-- Big Thing in the supervisor (ADR-010).
--
-- How a goal's plan is worked: `agent` lets the orchestrator delegate the
-- tasks itself; `runner` has the engine hand ready tasks to the team's
-- workers in parallel, by capability, respecting `depends_on`.
ALTER TABLE odysseys ADD COLUMN dispatch TEXT NOT NULL DEFAULT 'agent' CHECK (dispatch IN ('agent', 'runner'));
-- With runner dispatch: a finished task is reviewed by a worker on another
-- provider before the milestone goes back to the orchestrator.
ALTER TABLE odysseys ADD COLUMN review_tasks INTEGER NOT NULL DEFAULT 0;
-- Whether the run gets its own branch and worktree when it starts, and the
-- worktree it got. `source_workspace_id` is the checkout it branched from,
-- which a merge goes back into.
ALTER TABLE odysseys ADD COLUMN isolate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE odysseys ADD COLUMN source_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE odysseys ADD COLUMN worktree_path TEXT;
ALTER TABLE odysseys ADD COLUMN branch TEXT;
ALTER TABLE odysseys ADD COLUMN base_ref TEXT;
-- How the run spends the accounts: `drain` stays on one until it is spent;
-- `spread` moves to the account with the most room at a milestone boundary.
ALTER TABLE odysseys ADD COLUMN account_policy TEXT NOT NULL DEFAULT 'drain' CHECK (account_policy IN ('drain', 'spread'));
-- The team the run was started with (orchestrator and workers, JSON), so a
-- run opened from a preset keeps it across moves.
ALTER TABLE odysseys ADD COLUMN team TEXT;

-- What a task needs from a worker, and the job the runner gave it to.
ALTER TABLE odyssey_steps ADD COLUMN capability TEXT;
ALTER TABLE odyssey_steps ADD COLUMN job_id TEXT;
-- A cross-provider review of the task's result, once one ran.
ALTER TABLE odyssey_steps ADD COLUMN review TEXT;

-- Who a prompt went to: the provider and model of the session it was
-- submitted on, for the timeline of who did each milestone.
ALTER TABLE odyssey_journal ADD COLUMN provider TEXT;
ALTER TABLE odyssey_journal ADD COLUMN model TEXT;

-- The project's shared memory: decisions, conventions and facts the
-- orchestrator and its workers read and write through the `memory_*` tools.
CREATE TABLE project_memory (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'convention', 'fact', 'todo', 'warning')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  -- Who wrote it: `user`, or the session's provider and worker name.
  author TEXT NOT NULL,
  odyssey_id TEXT REFERENCES odysseys(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX project_memory_workspace ON project_memory (workspace_id, updated_at DESC);
