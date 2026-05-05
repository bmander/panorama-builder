-- An observation has no meaningful identity once its CP is gone — orphaned
-- rows just clutter the photos.
ALTER TABLE image_measurements
  DROP CONSTRAINT image_measurements_control_point_id_fkey;
ALTER TABLE image_measurements
  ADD CONSTRAINT image_measurements_control_point_id_fkey
  FOREIGN KEY (control_point_id) REFERENCES control_points(id) ON DELETE CASCADE;
