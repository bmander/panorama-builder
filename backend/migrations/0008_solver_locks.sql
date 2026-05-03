-- Per-attribute lock columns for the backend solver. The solver treats any
-- column flagged true as a fixed input; everything else is free to refine.
-- Existing rows default to unlocked.

ALTER TABLE stations
  ADD COLUMN lock_lat BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN lock_lng BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE photos
  ADD COLUMN lock_photo_az   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN lock_photo_tilt BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN lock_photo_roll BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN lock_size_rad   BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE control_points
  ADD COLUMN lock_est_lat BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN lock_est_lng BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN lock_est_alt BOOLEAN NOT NULL DEFAULT FALSE;
