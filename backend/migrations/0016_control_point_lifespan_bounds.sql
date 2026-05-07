-- When true, the matching date column is a strict bound (the landmark
-- started after / ended before that timestamp), not the exact moment.
-- Meaningful only when the corresponding *_at column is non-null.

ALTER TABLE control_points
  ADD COLUMN started_after BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN ended_before  BOOLEAN NOT NULL DEFAULT FALSE;
