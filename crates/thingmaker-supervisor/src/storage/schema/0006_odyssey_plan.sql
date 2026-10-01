-- The source document a goal was planned from (docs/plans/odyssey.md §3.1).
--
-- Dropping a roadmap on a goal does not parse it: the document is stored here
-- and handed to the session's model, which proposes the milestones. Keeping it
-- on the row makes the planning turn survive a reload, and makes it possible
-- to ask for the plan again from the same source.

ALTER TABLE odysseys ADD COLUMN plan_document TEXT;
-- Where it came from (a file name), for the card that shows what was read.
ALTER TABLE odysseys ADD COLUMN plan_source TEXT;
