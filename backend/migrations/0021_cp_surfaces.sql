-- Polygonal surfaces anchored on 3 (triangle) or 4 (quad) control points.
-- A surface is purely visual: two pre-existing CP-CP constraints share the
-- anchoring CPs, but no FK from surface to constraint exists since surfaces
-- should outlive the constraints that inspired them.
--
-- cp_4_id NULL  → triangle (3 distinct CPs in cp_1..cp_3)
-- cp_4_id set   → quad     (4 distinct CPs in cp_1..cp_4, in cyclic order)
--
-- ON DELETE CASCADE on every FK column: deleting any anchoring CP removes
-- the surface, matching the cp_constraints policy.

CREATE TABLE cp_surfaces (
  id          TEXT PRIMARY KEY,
  cp_1_id     TEXT NOT NULL REFERENCES control_points(id) ON DELETE CASCADE,
  cp_2_id     TEXT NOT NULL REFERENCES control_points(id) ON DELETE CASCADE,
  cp_3_id     TEXT NOT NULL REFERENCES control_points(id) ON DELETE CASCADE,
  cp_4_id     TEXT          REFERENCES control_points(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cp_1_id <> cp_2_id AND cp_1_id <> cp_3_id AND cp_2_id <> cp_3_id),
  CHECK (cp_4_id IS NULL OR
         (cp_4_id <> cp_1_id AND cp_4_id <> cp_2_id AND cp_4_id <> cp_3_id))
);

CREATE INDEX cp_surfaces_cp_1_idx ON cp_surfaces(cp_1_id);
CREATE INDEX cp_surfaces_cp_2_idx ON cp_surfaces(cp_2_id);
CREATE INDEX cp_surfaces_cp_3_idx ON cp_surfaces(cp_3_id);
CREATE INDEX cp_surfaces_cp_4_idx ON cp_surfaces(cp_4_id);
