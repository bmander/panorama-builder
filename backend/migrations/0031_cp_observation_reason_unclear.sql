-- Merge cp_observation reasons too_far + out_of_focus into a single
-- `unclear`. The original distinction wasn't carrying its weight at the UI
-- level — both meant "the CP geometry says it should be in frame but the
-- pixels don't resolve it" — and a single bucket reads more honestly.
--
-- The cp_observations row data is one rewrite; the session_ops journal
-- carries historical snapshots of those same reasons inside JSONB blobs,
-- so revert paths over old commits need the same swap or they'd write a
-- value the new CHECK constraint rejects.

BEGIN;

-- Drop the old constraint first so the in-place rewrite below isn't
-- rejected before the new one takes its place. The name is the Postgres
-- default (`<table>_<column>_check`) because 0026 declared it inline.
ALTER TABLE cp_observations
  DROP CONSTRAINT cp_observations_reason_check;

UPDATE cp_observations SET reason = 'unclear'
 WHERE reason IN ('too_far', 'out_of_focus');

UPDATE session_ops
   SET before_json = jsonb_set(before_json, '{reason}', '"unclear"')
 WHERE entity_type = 'cp_observation'
   AND before_json IS NOT NULL
   AND before_json->>'reason' IN ('too_far', 'out_of_focus');

UPDATE session_ops
   SET after_json = jsonb_set(after_json, '{reason}', '"unclear"')
 WHERE entity_type = 'cp_observation'
   AND after_json IS NOT NULL
   AND after_json->>'reason' IN ('too_far', 'out_of_focus');

ALTER TABLE cp_observations
  ADD CONSTRAINT cp_observations_reason_check
  CHECK (reason IS NULL OR reason IN ('occluded', 'unclear', 'other'));

COMMIT;
