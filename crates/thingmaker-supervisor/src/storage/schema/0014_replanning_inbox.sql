-- Dynamic replanning and the intervention inbox (docs/plans/odyssey.md §11.9, §11.10).
--
-- A plan change the agent proposes is held as a diff the user reads before
-- it lands, unless the goal says to apply and show. A question the agent
-- raises — a genuine ambiguity, a fork, a conflict, a repeated failure — is a
-- row the user answers when they look, while the agent carries on with the
-- default it named. Neither blocks the run; both surface in one inbox.

ALTER TABLE odysseys ADD COLUMN on_plan_change TEXT NOT NULL DEFAULT 'tasks_auto';

CREATE TABLE odyssey_plan_changes (
  id TEXT PRIMARY KEY,
  odyssey_id TEXT NOT NULL REFERENCES odysseys(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  -- The operations as the renderer parsed them (JSON); the desktop stores,
  -- the renderer applies.
  ops TEXT NOT NULL,
  -- The diff, one line per operation, as shown to the user.
  summary TEXT NOT NULL,
  -- Why the agent says the plan no longer fits, when it said.
  reason TEXT,
  state TEXT NOT NULL DEFAULT 'proposed',
  decided_at INTEGER,
  -- The user's note when rejecting, carried back to the agent.
  decision_note TEXT
);
CREATE INDEX idx_odyssey_plan_changes ON odyssey_plan_changes (odyssey_id, at DESC);

CREATE TABLE odyssey_questions (
  id TEXT PRIMARY KEY,
  odyssey_id TEXT NOT NULL REFERENCES odysseys(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  -- JSON array of the choices the agent offered, may be empty.
  options TEXT NOT NULL DEFAULT '[]',
  -- What the agent is doing until it hears back.
  fallback TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_at INTEGER
);
CREATE INDEX idx_odyssey_questions ON odyssey_questions (odyssey_id, at DESC);
