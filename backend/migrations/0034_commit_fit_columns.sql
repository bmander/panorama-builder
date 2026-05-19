-- Per-commit "errors saved anyway" count and fit score, surfaced on the
-- /history page so users can see what state they merged into.
--
-- error_count: number of merge-gate-flagged entities at merge time, even
-- when the user bypassed the gate via allow_underdetermined=true. NULL on
-- commits from before this migration and on revert commits.
--
-- fit_score: final_residual_rms of the most recent solver run in the
-- session that produced this commit. NULL when the session ran no solve
-- before merging, on commits from before this migration, and on revert
-- commits.
ALTER TABLE commits
  ADD COLUMN error_count INTEGER,
  ADD COLUMN fit_score   DOUBLE PRECISION;

-- last_solve_rms is updated by the solve handlers after a successful run
-- so mergeSession can read the value at merge time.
ALTER TABLE sessions
  ADD COLUMN last_solve_rms DOUBLE PRECISION;
