-- Map observations are now part of the control point's seed estimate
-- (est_lat / est_lng / est_alt set at creation), not a separate row.
DROP TABLE IF EXISTS map_measurements;
