-- Backfill est_alt = 0 for any control point that lacks an altitude estimate,
-- then make the column NOT NULL with a 0 default. The solver always works in
-- 3D (a Δel residual per observation needs a target altitude), and downstream
-- rendering also benefits from the column being known-non-null. Existing CPs
-- can still be refined: the user can unlock lock_est_alt and run a solve.

UPDATE control_points SET est_alt = 0 WHERE est_alt IS NULL;
ALTER TABLE control_points ALTER COLUMN est_alt SET NOT NULL;
ALTER TABLE control_points ALTER COLUMN est_alt SET DEFAULT 0;
