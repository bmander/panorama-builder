-- Existing stations predate the required capture timestamp. Preserve them by
-- using the row creation time as the best available capture-time fallback,
-- then enforce the invariant for all future writes.

UPDATE stations
SET captured_at = created_at
WHERE captured_at IS NULL;

ALTER TABLE stations
  ALTER COLUMN captured_at SET NOT NULL;
