-- Changing a goal while it runs (docs/plans/odyssey.md §3.2).
--
-- The user has more to say after the run started: a document, a folder of new
-- assets, a correction. It cannot be submitted straight away — the session is
-- usually mid-turn, and an agent refuses a second prompt — so it is queued here and
-- carried to the model on its next prompt. The model decides where it belongs
-- in the plan and replies with an amendment block; this row records the round
-- trip so nothing the user asked for is silently dropped.

CREATE TABLE odyssey_amendments (
  id TEXT PRIMARY KEY,
  odyssey_id TEXT NOT NULL REFERENCES odysseys(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  -- What the user wants. Always present: a reference with no instruction is
  -- not an amendment, it is a file.
  note TEXT NOT NULL,
  -- A document from outside the workspace, inlined in the prompt because the
  -- agent's own tools cannot reach it. Files inside the workspace are
  -- referenced by path instead and read by the agent.
  document TEXT,
  document_source TEXT,
  -- JSON array of {path, kind, detail}: workspace-relative references the
  -- agent can open itself, summarised when they were added.
  refs TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'told', 'applied', 'discarded')),
  -- The turn that carried it, and the one that acted on it.
  told_at INTEGER,
  settled_at INTEGER
);

CREATE INDEX idx_odyssey_amendments_goal ON odyssey_amendments (odyssey_id, at DESC);
