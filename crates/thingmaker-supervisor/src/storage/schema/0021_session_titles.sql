-- The title a session had, kept so it survives the session closing: the
-- provider's own title (Claude Code's ai-title, Codex's thread name) or the
-- first prompt. Separate from title_overlay, the person's rename, which wins
-- and which, cleared, gives this one back. NULL: not looked for yet; '': looked
-- for and none found.
ALTER TABLE sessions ADD COLUMN auto_title TEXT;
