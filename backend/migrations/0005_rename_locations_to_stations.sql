-- Survey/photogrammetry vocabulary: a "station" is a single camera setup point
-- (where the panorama is taken). Rename the table and FK columns to match.

ALTER TABLE locations RENAME TO stations;
ALTER INDEX idx_locations_geom RENAME TO idx_stations_geom;

ALTER TABLE photos RENAME COLUMN location_id TO station_id;
ALTER INDEX idx_photos_location RENAME TO idx_photos_station;

ALTER TABLE map_measurements RENAME COLUMN location_id TO station_id;
ALTER INDEX idx_map_measurements_location RENAME TO idx_map_measurements_station;
