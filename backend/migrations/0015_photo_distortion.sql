-- Add Brown-Conrady radial distortion coefficients to each photo, plus their
-- solver locks. Defaults are k=0 (no distortion) and lock=true so existing
-- photos behave exactly as before; the user opts a photo into a richer
-- camera model by unlocking k1/k2 and running a solve.

ALTER TABLE photos
  ADD COLUMN dist_k1 DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN dist_k2 DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN lock_dist_k1 BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN lock_dist_k2 BOOLEAN NOT NULL DEFAULT TRUE;
