-- Decouple map_measurements from stations. A map observation is a global,
-- station-less assertion about a control point's location.

DROP INDEX IF EXISTS idx_map_measurements_station;
ALTER TABLE map_measurements DROP COLUMN station_id;
