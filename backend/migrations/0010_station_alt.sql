-- Stations gain an altitude (meters above sea level) and a per-row lock.
-- Default 0 backfills existing rows; the solver will treat station alt as a
-- fixed input in residual bearing computations (no free slot is added yet).
-- lock_alt is exposed for symmetry with lat/lng locks and future-readiness
-- in case station alt becomes a free solver parameter.

ALTER TABLE stations
  ADD COLUMN alt DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN lock_alt BOOLEAN NOT NULL DEFAULT FALSE;
