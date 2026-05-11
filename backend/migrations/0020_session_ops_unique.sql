-- Coalesce ops at write time: each session keeps at most one op per
-- (entity_type, entity_id). recordOp merges into the existing row rather
-- than appending. The unique constraint enforces the invariant at the
-- schema level.
--
-- Existing duplicates (from sessions created before this migration) are
-- collapsed by keeping the row with the highest seq — an approximation of
-- the proper insert+update/update+delete reduction that's good enough for
-- the dev sessions in flight. After this drop, the index/constraint takes
-- over.

DELETE FROM session_ops a
USING session_ops b
WHERE a.session_id = b.session_id
  AND a.entity_type = b.entity_type
  AND a.entity_id = b.entity_id
  AND a.seq < b.seq;

ALTER TABLE session_ops
  ADD CONSTRAINT session_ops_entity_uniq
  UNIQUE (session_id, entity_type, entity_id);
