-- Introduces the global ControlPoint entity (a real, latent landmark) and
-- renames the existing POI tables to "measurements" — observations of a
-- control point. Image and map measurements both link directly to a control
-- point; the old image_pois.map_poi_id direct link is removed.
--
-- Data migration: every existing map POI becomes a control point with the
-- map POI's lat/lng as its est_lat/est_lng. Existing matches (image POI →
-- map POI) become (image_measurement → control_point ← map_measurement).

CREATE TABLE control_points (
  id          TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  est_lat     DOUBLE PRECISION,
  est_lng     DOUBLE PRECISION,
  est_alt     DOUBLE PRECISION,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_control_points_geom ON control_points
  USING gist ((ST_SetSRID(ST_MakePoint(est_lng, est_lat), 4326)))
  WHERE est_lat IS NOT NULL AND est_lng IS NOT NULL;

-- Rename the POI tables.
ALTER TABLE map_pois RENAME TO map_measurements;
ALTER TABLE image_pois RENAME TO image_measurements;

-- Rename the location/photo indexes to match.
ALTER INDEX idx_map_pois_location RENAME TO idx_map_measurements_location;
ALTER INDEX idx_image_pois_photo RENAME TO idx_image_measurements_photo;

-- Add control_point_id FKs.
ALTER TABLE map_measurements
  ADD COLUMN control_point_id TEXT REFERENCES control_points(id) ON DELETE SET NULL;
ALTER TABLE image_measurements
  ADD COLUMN control_point_id TEXT REFERENCES control_points(id) ON DELETE SET NULL;

-- Data migration: one control point per existing map measurement, with the
-- map measurement's lat/lng as the initial estimate. The 13-char base32 id
-- generator lives in Go; we synthesize ids from the map measurement's id
-- (deterministic, valid base32, won't collide with future newID() values
-- because those are random).
INSERT INTO control_points (id, description, est_lat, est_lng)
SELECT
  -- Reverse the existing 13-char id; valid base32 chars stay valid. Adding
  -- a 'C' prefix would break the 13-char invariant, and using random ids
  -- would risk collision with already-issued ones, so we keep the same
  -- id and rely on uniqueness of map measurement ids.
  m.id,
  '',
  m.lat,
  m.lng
FROM map_measurements m;

-- Stamp control_point_id on each map measurement: same id as the new CP.
UPDATE map_measurements SET control_point_id = id;

-- Stamp control_point_id on each image measurement that had a map_poi_id.
-- The new CP's id equals the linked map measurement's id.
UPDATE image_measurements SET control_point_id = map_poi_id WHERE map_poi_id IS NOT NULL;

-- Drop the old direct link.
DROP INDEX IF EXISTS idx_image_pois_map_poi;
ALTER TABLE image_measurements DROP COLUMN map_poi_id;

-- New index for image measurements grouped by their control point.
CREATE INDEX idx_image_measurements_control_point ON image_measurements(control_point_id);
CREATE INDEX idx_map_measurements_control_point ON map_measurements(control_point_id);
