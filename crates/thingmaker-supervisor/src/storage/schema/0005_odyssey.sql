-- Odyssey: long-horizon goals (docs/plans/odyssey.md). One goal drives one
-- session. The record is private desktop metadata: the agent's transcript stays the
-- canonical agent history (ADR-06) and nothing here is replayed into it.

CREATE TABLE odysseys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The desktop session row this goal drives. Nulled rather than deleted if
  -- the session record goes away, so the journal survives.
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'running', 'waiting_usage', 'paused', 'blocked', 'complete', 'abandoned')),
  stop_condition TEXT NOT NULL DEFAULT 'goal_complete'
    CHECK (stop_condition IN ('goal_complete', 'milestone_complete', 'manual')),
  on_usage_reset TEXT NOT NULL DEFAULT 'notify_only'
    CHECK (on_usage_reset IN ('continue_automatically', 'notify_only', 'stop')),
  max_continuations INTEGER NOT NULL,
  continuations_used INTEGER NOT NULL DEFAULT 0,
  -- Paid input + output tokens; NULL means no ceiling, and the count is still
  -- recorded so a run can be priced afterwards.
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One live goal per session; abandoned and complete goals stay for the record.
CREATE UNIQUE INDEX idx_odyssey_session_live ON odysseys (session_id)
  WHERE session_id IS NOT NULL AND state NOT IN ('complete', 'abandoned');
CREATE INDEX idx_odyssey_workspace ON odysseys (workspace_id, created_at DESC);

CREATE TABLE odyssey_milestones (
  id TEXT PRIMARY KEY,
  odyssey_id TEXT NOT NULL REFERENCES odysseys(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned', 'active', 'reported', 'verified', 'failed', 'skipped')),
  -- How completion is decided. 'manual' means only the user can tick it, and
  -- no check output can ever stand in for that.
  check_kind TEXT NOT NULL DEFAULT 'manual'
    CHECK (check_kind IN ('manual', 'command', 'files_exist', 'tests_pass')),
  check_spec TEXT,
  check_ran_at INTEGER,
  check_passed INTEGER,
  check_output TEXT,
  -- Which lane produced the evidence: we ran it, or we read the runtime's own
  -- tool record. They are not equally strong, so the badge says which.
  check_source TEXT CHECK (check_source IN ('desktop', 'agent_tool_result', 'user')),
  verified_at INTEGER,
  reported_note TEXT,
  UNIQUE (odyssey_id, position)
);

CREATE INDEX idx_odyssey_milestones ON odyssey_milestones (odyssey_id, position);

CREATE TABLE odyssey_steps (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES odyssey_milestones(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'in_progress', 'done', 'blocked')),
  note TEXT NOT NULL DEFAULT '',
  UNIQUE (milestone_id, position)
);

CREATE INDEX idx_odyssey_steps ON odyssey_steps (milestone_id, position);

-- Append-only account of what the runner did, so a run can be read back.
CREATE TABLE odyssey_journal (
  id TEXT PRIMARY KEY,
  odyssey_id TEXT NOT NULL REFERENCES odysseys(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('continuation', 'briefing', 'report', 'checkpoint', 'check', 'wait', 'resume', 'guard', 'state', 'plan')),
  milestone_id TEXT REFERENCES odyssey_milestones(id) ON DELETE SET NULL,
  baseline_id TEXT REFERENCES review_baselines(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX idx_odyssey_journal ON odyssey_journal (odyssey_id, at DESC);
