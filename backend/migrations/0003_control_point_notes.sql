-- Distinct from `description` (which is the short display name): notes hold
-- longer free-form prose. NOT NULL DEFAULT '' so existing rows backfill cleanly.

ALTER TABLE control_points
  ADD COLUMN notes TEXT NOT NULL DEFAULT '';
