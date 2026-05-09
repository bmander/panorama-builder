-- Hard pairwise constraints between control points. constraint_type:
--   'plumb' -- the two CPs share est_lat and est_lng (vertical line)
--   'level' -- the two CPs share est_alt           (horizontal alignment)
-- The solver eliminates the shared parameter via per-axis union-find.
-- cp_a_id < cp_b_id is enforced so a pair has a single canonical row.

CREATE TABLE cp_constraints (
  id              TEXT PRIMARY KEY,
  cp_a_id         TEXT NOT NULL REFERENCES control_points(id) ON DELETE CASCADE,
  cp_b_id         TEXT NOT NULL REFERENCES control_points(id) ON DELETE CASCADE,
  constraint_type TEXT NOT NULL CHECK (constraint_type IN ('plumb', 'level')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cp_a_id < cp_b_id),
  UNIQUE (cp_a_id, cp_b_id, constraint_type)
);

CREATE INDEX cp_constraints_cp_a_idx ON cp_constraints(cp_a_id);
CREATE INDEX cp_constraints_cp_b_idx ON cp_constraints(cp_b_id);
