-- Drop ON DELETE CASCADE from the FKs that the session-and-merge layer
-- must own. With CASCADE, deleting a parent at merge time silently dropped
-- dependents in main without touching session_ops or entity_commits, so a
-- revert restored the parent but not the children — the rollback was
-- incomplete.
--
-- RESTRICT (not NO ACTION) forces the FK violation immediately, so a
-- delete*InSession handler that forgets to walk its children fails loudly
-- at merge instead of quietly nuking shared state.
--
-- Constraint names are normalized to the current <table>_<column>_fkey
-- convention; the previous names (photos_location_id_fkey,
-- image_pois_photo_id_fkey) survived from before the location→station and
-- image_pois→image_measurements renames.
--
-- session_ops.session_id keeps its CASCADE — that's an admin-side
-- cleanup, not a user-data cascade.

ALTER TABLE photos
  DROP CONSTRAINT photos_location_id_fkey,
  ADD CONSTRAINT photos_station_id_fkey
    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE RESTRICT;

ALTER TABLE image_measurements
  DROP CONSTRAINT image_pois_photo_id_fkey,
  ADD CONSTRAINT image_measurements_photo_id_fkey
    FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE RESTRICT;

ALTER TABLE image_measurements
  DROP CONSTRAINT image_measurements_control_point_id_fkey,
  ADD CONSTRAINT image_measurements_control_point_id_fkey
    FOREIGN KEY (control_point_id) REFERENCES control_points(id) ON DELETE RESTRICT;

ALTER TABLE cp_constraints
  DROP CONSTRAINT cp_constraints_cp_a_id_fkey,
  ADD CONSTRAINT cp_constraints_cp_a_id_fkey
    FOREIGN KEY (cp_a_id) REFERENCES control_points(id) ON DELETE RESTRICT;

ALTER TABLE cp_constraints
  DROP CONSTRAINT cp_constraints_cp_b_id_fkey,
  ADD CONSTRAINT cp_constraints_cp_b_id_fkey
    FOREIGN KEY (cp_b_id) REFERENCES control_points(id) ON DELETE RESTRICT;

ALTER TABLE cp_surfaces
  DROP CONSTRAINT cp_surfaces_cp_1_id_fkey,
  ADD CONSTRAINT cp_surfaces_cp_1_id_fkey
    FOREIGN KEY (cp_1_id) REFERENCES control_points(id) ON DELETE RESTRICT;

ALTER TABLE cp_surfaces
  DROP CONSTRAINT cp_surfaces_cp_2_id_fkey,
  ADD CONSTRAINT cp_surfaces_cp_2_id_fkey
    FOREIGN KEY (cp_2_id) REFERENCES control_points(id) ON DELETE RESTRICT;

ALTER TABLE cp_surfaces
  DROP CONSTRAINT cp_surfaces_cp_3_id_fkey,
  ADD CONSTRAINT cp_surfaces_cp_3_id_fkey
    FOREIGN KEY (cp_3_id) REFERENCES control_points(id) ON DELETE RESTRICT;

ALTER TABLE cp_surfaces
  DROP CONSTRAINT cp_surfaces_cp_4_id_fkey,
  ADD CONSTRAINT cp_surfaces_cp_4_id_fkey
    FOREIGN KEY (cp_4_id) REFERENCES control_points(id) ON DELETE RESTRICT;
