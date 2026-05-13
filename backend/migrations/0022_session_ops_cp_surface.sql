-- Allow journaling cp_surface entity ops. The session_ops.entity_type
-- check from 0018 predates cp_surfaces; rebuild it so inserts/deletes of
-- the new entity don't hit a 23514 check-constraint violation.

ALTER TABLE session_ops
  DROP CONSTRAINT session_ops_entity_type_check;

ALTER TABLE session_ops
  ADD CONSTRAINT session_ops_entity_type_check
  CHECK (entity_type IN
    ('station', 'photo', 'image_measurement', 'control_point',
     'cp_constraint', 'cp_surface'));
