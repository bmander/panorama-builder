-- captured_at records when the photographer's setup was actually photographing
-- the scene. Distinct from created_at (the row-insert wallclock) and from any
-- per-photo EXIF timestamp. Nullable: many uploaded photos predate the dataset
-- and the user hasn't reconstructed an exact time yet.

ALTER TABLE stations
  ADD COLUMN captured_at TIMESTAMPTZ;
