-- Lifespan of the real-world landmark, distinct from the row's created_at /
-- updated_at audit timestamps. Both nullable — most CPs have no known dates.

ALTER TABLE control_points
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN ended_at   TIMESTAMPTZ;
