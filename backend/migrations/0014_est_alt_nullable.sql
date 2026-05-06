-- Make est_alt nullable again. Migration 0009 forced est_alt to 0 for any
-- CP without an altitude estimate so the solver could rely on a 3D guess;
-- this migration restores "unknown elevation" as a first-class state. The
-- solver still seeds null altitudes to 0 at problem-build time, so 3D
-- residuals still have a target — but the persisted column reflects
-- whether the user actually has an estimate.

ALTER TABLE control_points ALTER COLUMN est_alt DROP NOT NULL;
ALTER TABLE control_points ALTER COLUMN est_alt DROP DEFAULT;
