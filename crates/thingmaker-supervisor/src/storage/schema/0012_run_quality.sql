-- Odyssey run quality (docs/research/odyssey-review.md §5, items 3–5).
--
-- Three things the first real run showed the record could not say:
--
-- * Whether the subscription window charges cached input. The runner sampled
--   usage every minute and threw the samples away, so the one fact every spend
--   decision depends on stayed unmeasurable. Samples now land here, joined to
--   the transcript's own token counters at the moment they were taken.
-- * A default check for planning. Every one of twelve milestones came back
--   `manual`, so the whole verification ladder went unused and each claim sat
--   for a human — eight hours, once. The planner is now handed a test command
--   for the project and asked to use it.
-- * Which part of the plan document a milestone came from. `plan_path` gives
--   the agent the whole 54 KB; `section` tells it which two pages to read.

ALTER TABLE odyssey_milestones ADD COLUMN section TEXT;
ALTER TABLE odysseys ADD COLUMN default_check TEXT;

CREATE TABLE odyssey_usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  odyssey_id TEXT NOT NULL REFERENCES odysseys(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  -- The provider's two rolling windows as sampled. NULL when a window was not
  -- reported. `reset_at` is unix seconds, as the provider gives it.
  primary_used_percent INTEGER,
  primary_reset_at INTEGER,
  secondary_used_percent INTEGER,
  secondary_reset_at INTEGER,
  -- The session's cumulative counters from the agent's transcript at the same
  -- moment, so consecutive samples can be differenced.
  calls INTEGER NOT NULL,
  paid_input_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL
);

CREATE INDEX idx_odyssey_usage_samples ON odyssey_usage_samples (odyssey_id, at);
