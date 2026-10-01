-- Tasks inside milestones (docs/plans/odyssey.md §11.8).
--
-- Steps existed as titles with a state and nothing moved them: the agent had
-- no way to say one was done, they had no owner and no time, and the one
-- subagent the orchestrator raised per unit of work was tied to nothing. A
-- task keeps who ran it (the subagent's name and the harness and model the
-- desktop observed it on), what it waits for, and when it moved.

ALTER TABLE odyssey_steps ADD COLUMN detail TEXT NOT NULL DEFAULT '';
-- The subagent named for this task, as the agent reported it or as the
-- desktop matched it by name.
ALTER TABLE odyssey_steps ADD COLUMN agent_name TEXT;
-- Observed from the session stream when that subagent appeared: evidence,
-- not the agent's word.
ALTER TABLE odyssey_steps ADD COLUMN harness TEXT;
ALTER TABLE odyssey_steps ADD COLUMN model TEXT;
-- JSON array of step ids this task waits for. Ids, not numbers: a number
-- drifts when a task is added above it.
ALTER TABLE odyssey_steps ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
ALTER TABLE odyssey_steps ADD COLUMN started_at INTEGER;
ALTER TABLE odyssey_steps ADD COLUMN updated_at INTEGER;
ALTER TABLE odyssey_steps ADD COLUMN finished_at INTEGER;
