-- How work moves through a milestone's tasks beyond "after these ones":
--   kind      'work', or 'approval' — the user's own step: the run stops there
--             until they approve, send the work back, or stop the run.
--   uses      ids of tasks whose results this one is given ('[]': none).
--   result    the task's own result, bounded, once it has one.
--   loop_to   the task to go back to when this one asks for changes; the
--             tasks between the two run again.
--   loop_limit / loop_at_limit
--             how many rounds before the loop stops (NULL: no limit), and
--             what then happens: 'ask' the user, 'stop' the run, or
--             'continue' with the work as it is.
--   round     which attempt this task is on, from 1.
--   feedback  what the last loop back asked of this task.
ALTER TABLE odyssey_steps ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
ALTER TABLE odyssey_steps ADD COLUMN uses TEXT NOT NULL DEFAULT '[]';
ALTER TABLE odyssey_steps ADD COLUMN result TEXT;
ALTER TABLE odyssey_steps ADD COLUMN loop_to TEXT;
ALTER TABLE odyssey_steps ADD COLUMN loop_limit INTEGER;
ALTER TABLE odyssey_steps ADD COLUMN loop_at_limit TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE odyssey_steps ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE odyssey_steps ADD COLUMN feedback TEXT;
-- The task a question stands for: an approval step, or a loop at its limit.
ALTER TABLE odyssey_questions ADD COLUMN step_id TEXT;
