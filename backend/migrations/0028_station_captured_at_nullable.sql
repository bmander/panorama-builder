-- The station's own capture date is best-effort, not authoritative — users
-- often only have a rough guess and inventing a placeholder lets that
-- guess propagate as a "fact" into anything that anchors on it. Allow
-- captured_at to be NULL so observation-graph derivations can simply skip
-- stations whose date is unknown rather than reasoning about a sentinel.
--
-- Existing rows all have a value (the column has been NOT NULL since
-- 0013); this migration only relaxes the constraint.

ALTER TABLE stations ALTER COLUMN captured_at DROP NOT NULL;
