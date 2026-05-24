-- Snapshot of a session's journal taken just before a solver writeback, so
-- the most recent solve can be undone from within the still-open session
-- (pre-merge). Like session_ops itself this is session scratch: it never
-- reaches main and carries no commit, so undoing it needs no sign_off — it's
-- the pre-merge analogue of dragging the entities back by hand.
--
-- Holds the full pre-solve journal plus the session's next_seq and
-- last_solve_rms so undoSolve can restore the exact prior state. Overwritten
-- by each solve, cleared on undo, and irrelevant once the session merges.
ALTER TABLE sessions
  ADD COLUMN solve_undo_json JSONB;
