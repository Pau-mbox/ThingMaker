-- Telling the model about an amendment more than once
-- (docs/plans/odyssey.md §3.2).
--
-- An amendment was carried on exactly one prompt and then marked `told`,
-- which assumed the model would act on it in that turn. One did not: it was
-- told once, deferred, and forty-six continuations later the prompt that
-- carried it had long since been compacted out of context. The model had no
-- way to remember it existed, and nothing ever asked again.
--
-- So a telling is now counted and dated in continuations, and an amendment
-- that has not been acted on is carried again — a few times, not for ever,
-- because repeating something the model keeps declining is just spend.
ALTER TABLE odyssey_amendments ADD COLUMN tell_count INTEGER NOT NULL DEFAULT 0;
-- The goal's `continuations_used` when it was last carried. NULL for rows
-- written before this column existed, which reads as "due to be told again".
ALTER TABLE odyssey_amendments ADD COLUMN told_at_continuation INTEGER;
