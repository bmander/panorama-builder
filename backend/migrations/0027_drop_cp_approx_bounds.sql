-- The started_after / ended_before flag pair encoded "this date is an
-- approximate bound, not an exact event." That overload is replaced by
-- two separate concepts:
--
--   * started_at / ended_at remain — but mean only precise, certain events.
--   * Implicit bounds are derived from cp_observations (see 0026) plus
--     station capture dates, and materialized into the four *_lower /
--     *_upper columns added below. Recomputed inside mergeSession after
--     every write that affects an input.
--
-- Approximate-bound dates were never precise events, so the rows where
-- the flag is set lose the date entirely. The flag columns themselves go
-- away.

UPDATE control_points SET started_at = NULL WHERE started_after = TRUE;
UPDATE control_points SET ended_at   = NULL WHERE ended_before  = TRUE;

ALTER TABLE control_points
  DROP COLUMN started_after,
  DROP COLUMN ended_before;

ALTER TABLE control_points
  ADD COLUMN started_at_lower         TIMESTAMPTZ,
  ADD COLUMN started_at_upper         TIMESTAMPTZ,
  ADD COLUMN ended_at_lower           TIMESTAMPTZ,
  ADD COLUMN ended_at_upper           TIMESTAMPTZ,
  ADD COLUMN derivation_inconsistent  BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: a precise date is both bounds of itself.
UPDATE control_points
   SET started_at_lower = started_at,
       started_at_upper = started_at
 WHERE started_at IS NOT NULL;

UPDATE control_points
   SET ended_at_lower = ended_at,
       ended_at_upper = ended_at
 WHERE ended_at IS NOT NULL;

-- The time-filter scan: "show CPs possibly extant on date t" needs
-- (started_at_lower <= t) AND (ended_at_upper >= t).
CREATE INDEX control_points_window_idx
  ON control_points (started_at_lower, ended_at_upper);
