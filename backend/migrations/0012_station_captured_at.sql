-- captured_at records when the photographer's setup was actually photographing
-- the scene. Distinct from created_at (the row-insert wallclock) and from any
-- per-photo EXIF timestamp.

ALTER TABLE stations
  ADD COLUMN captured_at TIMESTAMPTZ;
