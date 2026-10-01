-- Providers (docs/plans/odyssey-second-orchestrator.md).
--
-- `provider` names the subscription the row's session runs on: `claude`
-- (Claude Code through claude-agent-acp) or `codex` (Codex through its
-- app-server).
ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'
  CHECK (provider IN ('claude', 'codex'));

-- Which orchestrator a goal wants. `claude` and `codex` pin it; `either`
-- starts where it is and moves the goal to the other account when this one is
-- spent. A goal is re-pointed at a different session by `odyssey_repoint`,
-- which journals the move; the briefing then goes out again, because a
-- briefing is per session and the new session has never been told the goal.
ALTER TABLE odysseys ADD COLUMN orchestrator TEXT NOT NULL DEFAULT 'claude'
  CHECK (orchestrator IN ('claude', 'codex', 'either'));
