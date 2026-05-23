package core

import "github.com/bmander/panorama-builder/shared/wire"

type cpSnap struct{ lat, lng, alt float64 }

// SolveJointWithSeed runs a single-CP pre-solve for each id in seededCPIDs
// (locking everything else via wire.ModeSingleControlPoint), mutates problem to
// the refined positions, then runs wire.ModeJoint Solve. The returned Changes
// always carries the pre-pre-solve value as Before for each seeded CP, so
// pre-solve work is persisted even when the joint phase makes no further
// adjustment. OnIteration / ShouldStop on cfg are forwarded only to the
// joint phase.
func SolveJointWithSeed(problem wire.Problem, seededCPIDs []string, cfg Config) (wire.Result, error) {
	if len(seededCPIDs) == 0 {
		cfg.Mode = wire.ModeJoint
		return Solve(problem, cfg)
	}

	cpIdx := make(map[string]int, len(problem.ControlPoints))
	for i, cp := range problem.ControlPoints {
		cpIdx[cp.ID] = i
	}

	snap := make(map[string]cpSnap, len(seededCPIDs))
	for _, id := range seededCPIDs {
		if i, ok := cpIdx[id]; ok {
			cp := problem.ControlPoints[i]
			snap[id] = cpSnap{lat: cp.EstLat, lng: cp.EstLng, alt: cp.EstAlt}
		}
	}

	preCfg := cfg
	preCfg.Mode = wire.ModeSingleControlPoint
	preCfg.OnIteration = nil
	preCfg.ShouldStop = nil
	for id := range snap {
		preCfg.FocusID = id
		r, err := Solve(problem, preCfg)
		// Insufficient observations or per-CP divergence: skip and let the
		// joint phase try with the centroid seed still in place.
		if err != nil || r.Diverged {
			continue
		}
		applyCPAfter(&problem.ControlPoints[cpIdx[id]], r.Changes)
	}

	cfg.Mode = wire.ModeJoint
	res, err := Solve(problem, cfg)
	if err != nil {
		return res, err
	}

	// Solve currently flags Diverged whenever bestState == initialState,
	// including the legitimate case where the input was already at the
	// optimum. After pre-solve, joint may have nothing left to do — undo
	// the spurious flag so the caller's writeback persists pre-solve work.
	if res.Diverged && res.Iterations == 0 &&
		res.InitialResidualRMS == res.FinalResidualRMS &&
		hasSeededMovement(problem, cpIdx, snap) {
		res.Diverged = false
		res.Converged = true
	}

	res.Changes = mergeSeededCPChanges(res.Changes, problem, cpIdx, snap)
	return res, nil
}

func hasSeededMovement(problem wire.Problem, cpIdx map[string]int, snap map[string]cpSnap) bool {
	for id, s := range snap {
		cp := problem.ControlPoints[cpIdx[id]]
		if cp.EstLat != s.lat || cp.EstLng != s.lng || cp.EstAlt != s.alt {
			return true
		}
	}
	return false
}

func applyCPAfter(cp *wire.ControlPoint, changes []wire.EntityChange) {
	for _, c := range changes {
		if c.Kind != "control_point" || c.ID != cp.ID {
			continue
		}
		if v, ok := c.After["est_lat"]; ok {
			cp.EstLat = v
		}
		if v, ok := c.After["est_lng"]; ok {
			cp.EstLng = v
		}
		if v, ok := c.After["est_alt"]; ok {
			cp.EstAlt = v
		}
	}
}

// mergeSeededCPChanges replaces joint-phase control_point entries for any
// seeded CP with a synthetic entry whose Before is the pre-pre-solve value
// (so a seeded CP that pre-solve refined and joint left alone still
// persists). emitLLADiff applies the same per-axis fdEpsPosM threshold as
// composeChanges, evaluated at the CP's own latitude.
func mergeSeededCPChanges(jointChanges []wire.EntityChange, problem wire.Problem, cpIdx map[string]int, snap map[string]cpSnap) []wire.EntityChange {
	out := make([]wire.EntityChange, 0, len(jointChanges)+len(snap))
	for _, c := range jointChanges {
		if c.Kind == "control_point" {
			if _, seeded := snap[c.ID]; seeded {
				continue
			}
		}
		out = append(out, c)
	}
	for id, s := range snap {
		cp := problem.ControlPoints[cpIdx[id]]
		before := map[string]float64{}
		after := map[string]float64{}
		emitLLADiff(before, after, "est_",
			[3]float64{s.lat, s.lng, s.alt},
			[3]float64{cp.EstLat, cp.EstLng, cp.EstAlt})
		if len(after) == 0 {
			continue
		}
		out = append(out, wire.EntityChange{Kind: "control_point", ID: id, Before: before, After: after})
	}
	return out
}
