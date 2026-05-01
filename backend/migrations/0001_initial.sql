CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS locations (
  id          TEXT PRIMARY KEY,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Geometry index (not geography) so the bbox-intersection operator (&&) hits
-- it. KNN / true-distance queries can cast to ::geography on the fly.
CREATE INDEX IF NOT EXISTS idx_locations_geom ON locations
  USING gist ((ST_SetSRID(ST_MakePoint(lng, lat), 4326)));

CREATE TABLE IF NOT EXISTS photos (
  id            TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  blob_path     TEXT,
  mime_type     TEXT,
  size_bytes    BIGINT,
  aspect        DOUBLE PRECISION NOT NULL,
  photo_az      DOUBLE PRECISION NOT NULL DEFAULT 0,
  photo_tilt    DOUBLE PRECISION NOT NULL DEFAULT 0,
  photo_roll    DOUBLE PRECISION NOT NULL DEFAULT 0,
  size_rad      DOUBLE PRECISION NOT NULL DEFAULT 0.5236,  -- ~30 degrees
  opacity       DOUBLE PRECISION NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_photos_location ON photos(location_id);

CREATE TABLE IF NOT EXISTS map_pois (
  id          TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_map_pois_location ON map_pois(location_id);

CREATE TABLE IF NOT EXISTS image_pois (
  id          TEXT PRIMARY KEY,
  photo_id    TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  u           DOUBLE PRECISION NOT NULL,
  v           DOUBLE PRECISION NOT NULL,
  map_poi_id  TEXT REFERENCES map_pois(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_image_pois_photo ON image_pois(photo_id);
CREATE INDEX IF NOT EXISTS idx_image_pois_map_poi ON image_pois(map_poi_id);
