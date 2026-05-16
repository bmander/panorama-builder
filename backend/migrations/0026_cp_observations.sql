-- Per-station-per-CP observation status. The existence of an
-- image_measurement linking to a CP only encodes "I pinned a pixel" — it
-- can't say "I looked, the CP isn't there" or "I can't see it from here."
-- cp_observations is the single source of truth for the per-station
-- visibility statement; image_measurements that link to a CP are the
-- pixel-pinned evidence backing an `observed` row.
--
-- Status semantics:
--   observed  — CP visible from at least one of the station's photos
--   missing   — CP would be visible but isn't (born after / destroyed before)
--   cant_see  — CP can't be observed from here for non-temporal reasons
--               (occluded, too far, out of focus, …); reason required
--
-- FKs are RESTRICT (per migration 0024); the cascade walker in
-- delete{Station,ControlPoint}InSession journal-deletes these rows first.

CREATE TABLE cp_observations (
  id                TEXT PRIMARY KEY,
  station_id        TEXT NOT NULL REFERENCES stations(id)        ON DELETE RESTRICT,
  control_point_id  TEXT NOT NULL REFERENCES control_points(id)  ON DELETE RESTRICT,
  status            TEXT NOT NULL CHECK (status IN ('observed', 'missing', 'cant_see')),
  reason            TEXT CHECK (reason IS NULL OR reason IN
                       ('occluded', 'too_far', 'out_of_focus', 'other')),
  CHECK ((status = 'cant_see') = (reason IS NOT NULL)),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (station_id, control_point_id)
);

CREATE INDEX cp_observations_cp_idx      ON cp_observations(control_point_id);
CREATE INDEX cp_observations_station_idx ON cp_observations(station_id);

-- Allow journaling cp_observation entity ops.
ALTER TABLE session_ops
  DROP CONSTRAINT session_ops_entity_type_check;

ALTER TABLE session_ops
  ADD CONSTRAINT session_ops_entity_type_check
  CHECK (entity_type IN
    ('station', 'photo', 'image_measurement', 'control_point',
     'cp_constraint', 'cp_surface', 'cp_observation'));
