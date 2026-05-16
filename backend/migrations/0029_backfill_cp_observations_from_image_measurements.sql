-- Backfill cp_observations from historical image_measurements. Each distinct
-- (station_id, control_point_id) pair where an image_measurement links the
-- two becomes an `observed` cp_observation row, so pre-existing pixel pins
-- carry date evidence into the derived-window system the same way new
-- pins do (postImageMeasurementInSession auto-creates the row going forward).
--
-- Idempotent via the (station_id, control_point_id) UNIQUE index from
-- migration 0026 — re-runs insert nothing. No derived-window recompute is
-- needed here: at migration time every station.captured_at is NULL (it was
-- bulk-cleared in commit HVQK67WQQDKUY), so observed observations
-- contribute no temporal bound and the all-null derived columns stay
-- correct. The next merge that touches any of these CPs (incl. setting a
-- station date) will trigger the merge-time recompute and pick up the
-- backfilled observations naturally.

CREATE OR REPLACE FUNCTION pg_temp.gen_cp_observation_id() RETURNS text AS $$
  SELECT string_agg(
    substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', floor(random() * 32)::int + 1, 1),
    ''
  )
  FROM generate_series(1, 13);
$$ LANGUAGE sql VOLATILE;

INSERT INTO cp_observations (id, station_id, control_point_id, status, created_at, updated_at)
SELECT
  pg_temp.gen_cp_observation_id(),
  pair.station_id,
  pair.control_point_id,
  'observed',
  NOW(),
  NOW()
FROM (
  SELECT DISTINCT p.station_id, im.control_point_id
  FROM image_measurements im
  JOIN photos p ON p.id = im.photo_id
  WHERE im.control_point_id IS NOT NULL
) pair
ON CONFLICT (station_id, control_point_id) DO NOTHING;
