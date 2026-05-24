-- Unified per-session undo/redo: a bounded stack of journal snapshots.
--
-- The session journal (session_ops) is a coalesced terminal-state overlay, so
-- undo can't walk it backwards. Instead each undoable action snapshots the
-- whole journal (the shape proven by the now-removed solve_undo_json):
-- ops + next_seq + last_solve_rms. Undo pops the 'undo' stack and restores;
-- redo is symmetric. Like session_ops this is session scratch — it never
-- reaches main or the commit log, so undo/redo need no sign_off.
--
-- Actions are grouped by X-Action-Id: requireSession pushes a pre-action
-- snapshot the first time it sees a new id (tracked in current_action_id),
-- so one user gesture (which fans out into many writes) yields one checkpoint.
CREATE TABLE session_checkpoints (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stack         TEXT NOT NULL CHECK (stack IN ('undo', 'redo')),
  position      BIGINT NOT NULL,
  snapshot_json JSONB NOT NULL,
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, stack, position)
);

ALTER TABLE sessions ADD COLUMN current_action_id TEXT;

-- Superseded by the checkpoint stack above (single-level solve undo).
ALTER TABLE sessions DROP COLUMN solve_undo_json;
