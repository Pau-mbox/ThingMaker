-- A note to the agent is not a plan change (docs/plans/odyssey.md §11.10).
--
-- Every user message rode the amendment lane, which expects the agent to
-- answer with a plan change and re-asks until it does. An instruction — "do
-- not block on quota" — has no plan change in it, so it was re-told three
-- times and then surfaced as a change the agent had ignored. A `note` is
-- carried once and closed as delivered.
ALTER TABLE odyssey_amendments ADD COLUMN kind TEXT NOT NULL DEFAULT 'change';
