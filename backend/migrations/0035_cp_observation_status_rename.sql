-- Collapse cp_observation status + reason into a single three-valued status:
-- observed → present, missing → absent, cant_see → obscured. The distinction
-- between occluded and unclear no longer carries UI weight (the CP context
-- menu now drives this from a 3-button radio group), so reason is dropped.
--
-- As with 0031, the session_ops journal carries historical snapshots of these
-- same values inside JSONB blobs; revert paths over old commits need the same
-- rewrite or they'd produce values the new CHECK constraint rejects.

BEGIN;

-- 0026 declared three CHECKs inline: the column-level checks on status and
-- reason (Postgres-default names `<table>_<column>_check`) and an unnamed
-- table-level CHECK enforcing reason-iff-cant_see (named `<table>_check`).
-- 0031 already dropped+recreated the reason check, so the names here match.
ALTER TABLE cp_observations DROP CONSTRAINT cp_observations_status_check;
ALTER TABLE cp_observations DROP CONSTRAINT cp_observations_reason_check;
ALTER TABLE cp_observations DROP CONSTRAINT cp_observations_check;

UPDATE cp_observations SET status = CASE status
  WHEN 'observed' THEN 'present'
  WHEN 'missing'  THEN 'absent'
  WHEN 'cant_see' THEN 'obscured'
END;

ALTER TABLE cp_observations DROP COLUMN reason;

ALTER TABLE cp_observations
  ADD CONSTRAINT cp_observations_status_check
  CHECK (status IN ('present', 'absent', 'obscured'));

-- Rewrite session_ops JSONB snapshots in lockstep. before_json + after_json
-- both carry full CpObservation payloads; rewrite the status key and strip
-- the reason key in one pass per column.
UPDATE session_ops
   SET before_json = CASE WHEN before_json IS NULL THEN NULL ELSE
         jsonb_set(before_json, '{status}',
           to_jsonb(CASE before_json->>'status'
             WHEN 'observed' THEN 'present'
             WHEN 'missing'  THEN 'absent'
             WHEN 'cant_see' THEN 'obscured'
           END)) - 'reason' END,
       after_json = CASE WHEN after_json IS NULL THEN NULL ELSE
         jsonb_set(after_json, '{status}',
           to_jsonb(CASE after_json->>'status'
             WHEN 'observed' THEN 'present'
             WHEN 'missing'  THEN 'absent'
             WHEN 'cant_see' THEN 'obscured'
           END)) - 'reason' END
 WHERE entity_type = 'cp_observation';

COMMIT;
