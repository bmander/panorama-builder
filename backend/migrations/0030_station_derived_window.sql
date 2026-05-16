-- Materialize station-side derived bounds, symmetric to control_points'
-- *_lower/*_upper/derivation_inconsistent triple from migrations 0026/0027.
-- A station's captured_at is a single time point (not an interval), so the
-- derived window is just (lower, upper) — no started/ended distinction.
--
-- Both bounds are populated by recomputeAndJournalWindows (and its
-- session-aware sibling propagateDatesInSession) at solve time and merge
-- time. A station whose captured_at is non-null seeds both bounds to that
-- value; otherwise both stay null until propagation tightens them through
-- the observation graph.

ALTER TABLE stations
  ADD COLUMN captured_at_lower       TIMESTAMPTZ,
  ADD COLUMN captured_at_upper       TIMESTAMPTZ,
  ADD COLUMN derivation_inconsistent BOOLEAN NOT NULL DEFAULT FALSE;

-- A precise captured_at is both bounds of itself.
UPDATE stations
   SET captured_at_lower = captured_at,
       captured_at_upper = captured_at
 WHERE captured_at IS NOT NULL;

-- Mirror the CP-side filter index for symmetry and future server-side
-- date filters. Cheap at our scale.
CREATE INDEX stations_window_idx
  ON stations (captured_at_lower, captured_at_upper);
