package main

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// derived_window.go materializes implicit lifespan bounds on control_points
// AND capture-time bounds on stations from the observation graph.
//
// The model is a Simple Temporal Network (STN) of point variables:
//   - station.captured_at     (one point per station)
//   - cp.started_at, cp.ended_at (two points per CP)
// constrained by observed cp_observation edges (s observed c) giving
//   cp.started ≤ s.captured ≤ cp.ended.
//
// Bound-propagation rules per observed edge (s, c):
//   c.start_upper = min(c.start_upper, s.t_upper)
//   c.end_lower   = max(c.end_lower,   s.t_lower)
//   s.t_lower     = max(s.t_lower,     c.start_lower)
//   s.t_upper     = min(s.t_upper,     c.end_upper)
//
// Iterated to quiescence via a worklist; for our scale (~200 CPs, ~40
// stations, ~540 edges) it converges in microseconds. `missing`
// observations stay on a single-pass heuristic during initialization (peek
// at observed neighbors to disambiguate which side of the lifespan the
// missing date sits on); they're DTP-hard in general, out of scope.
//
// Two callers invoke the same in-memory propagator:
//   - propagateDatesInSession runs at solve time, reads main+overlay, and
//     emits journaled update ops via recordOp so the user previews the
//     propagated bounds in the session overlay before merge.
//   - recomputeAndJournalWindows runs at merge time (after applyPlanToMain)
//     as a safety net for the no-solve path, reading main directly and
//     applying updates to main as it journals.

// propagatedWindows is the fixed-point output of the propagator.
type propagatedWindows struct {
	CPs      map[string]DerivedWindow
	Stations map[string]StationDerivedWindow
}

// propagateWindows runs the STN bound-propagation to quiescence on the
// supplied graph state. Pure function — no I/O.
func propagateWindows(cps []ControlPoint, stations []Station, obs []CpObservation) propagatedWindows {
	type cpBounds struct {
		startLo, startHi, endLo, endHi *time.Time
		inconsistent                   bool
	}
	type stBounds struct {
		lo, hi       *time.Time
		inconsistent bool
	}
	cpState := make(map[string]*cpBounds, len(cps))
	stState := make(map[string]*stBounds, len(stations))
	stByID := make(map[string]*Station, len(stations))
	for i := range stations {
		stByID[stations[i].ID] = &stations[i]
	}

	// Seed CP bounds from precise dates; station bounds from precise
	// captured_at. Null inputs leave both bounds null (unbounded).
	for _, cp := range cps {
		cpState[cp.ID] = &cpBounds{
			startLo: cp.StartedAt, startHi: cp.StartedAt,
			endLo: cp.EndedAt, endHi: cp.EndedAt,
		}
	}
	for _, st := range stations {
		stState[st.ID] = &stBounds{lo: st.CapturedAt, hi: st.CapturedAt}
	}

	// Build observed-edge adjacency. Missing observations bucketed for the
	// disambiguation pass below.
	cpToObservers := make(map[string][]string) // cp id → station ids observing it
	stationToCPs := make(map[string][]string)  // station id → cp ids observed
	cpToMissing := make(map[string][]string)   // cp id → station ids marking missing
	for _, o := range obs {
		switch o.Status {
		case Observed:
			cpToObservers[o.ControlPointID] = append(cpToObservers[o.ControlPointID], o.StationID)
			stationToCPs[o.StationID] = append(stationToCPs[o.StationID], o.ControlPointID)
		case Missing:
			cpToMissing[o.ControlPointID] = append(cpToMissing[o.ControlPointID], o.StationID)
		}
	}

	// Missing-disambiguation pass (heuristic, single sweep, uses raw
	// station.captured_at for the neighbor check). Tightens CP-side
	// start_lower / end_upper, flags inconsistent on contradictions.
	for cpID, missStations := range cpToMissing {
		cpb := cpState[cpID]
		if cpb == nil {
			continue
		}
		for _, sID := range missStations {
			st := stByID[sID]
			if st == nil || st.CapturedAt == nil {
				continue
			}
			m := *st.CapturedAt
			var hasLater, hasEarlier bool
			for _, oSID := range cpToObservers[cpID] {
				ost := stByID[oSID]
				if ost == nil || ost.CapturedAt == nil {
					continue
				}
				if ost.CapturedAt.After(m) {
					hasLater = true
				}
				if ost.CapturedAt.Before(m) {
					hasEarlier = true
				}
			}
			if hasLater && hasEarlier {
				cpb.inconsistent = true
			}
			if hasLater {
				cpb.startLo = maxPtr(cpb.startLo, &m)
			}
			if hasEarlier {
				cpb.endHi = minPtr(cpb.endHi, &m)
			}
		}
	}

	// Worklist STN propagation on observed edges. Each entry is one
	// entity whose bounds might have moved and need to be pushed.
	type wlEntry struct {
		isCP bool
		id   string
	}
	worklist := make([]wlEntry, 0, len(cps)+len(stations))
	for id := range cpState {
		worklist = append(worklist, wlEntry{true, id})
	}
	for id := range stState {
		worklist = append(worklist, wlEntry{false, id})
	}

	for len(worklist) > 0 {
		e := worklist[len(worklist)-1]
		worklist = worklist[:len(worklist)-1]
		if e.isCP {
			cpb := cpState[e.id]
			for _, sID := range cpToObservers[e.id] {
				stb := stState[sID]
				if stb == nil {
					continue
				}
				// s.t_lower ≥ c.start_lower; s.t_upper ≤ c.end_upper
				moved := false
				if cpb.startLo != nil {
					if nv := maxPtr(stb.lo, cpb.startLo); nv != stb.lo {
						stb.lo = nv
						moved = true
					}
				}
				if cpb.endHi != nil {
					if nv := minPtr(stb.hi, cpb.endHi); nv != stb.hi {
						stb.hi = nv
						moved = true
					}
				}
				if moved {
					worklist = append(worklist, wlEntry{false, sID})
				}
			}
		} else {
			stb := stState[e.id]
			for _, cID := range stationToCPs[e.id] {
				cpb := cpState[cID]
				if cpb == nil {
					continue
				}
				// c.start_upper ≤ s.t_upper; c.end_lower ≥ s.t_lower
				moved := false
				if stb.hi != nil {
					if nv := minPtr(cpb.startHi, stb.hi); nv != cpb.startHi {
						cpb.startHi = nv
						moved = true
					}
				}
				if stb.lo != nil {
					if nv := maxPtr(cpb.endLo, stb.lo); nv != cpb.endLo {
						cpb.endLo = nv
						moved = true
					}
				}
				if moved {
					worklist = append(worklist, wlEntry{true, cID})
				}
			}
		}
	}

	// Detect contradictions + assemble outputs.
	out := propagatedWindows{
		CPs:      make(map[string]DerivedWindow, len(cps)),
		Stations: make(map[string]StationDerivedWindow, len(stations)),
	}
	for id, c := range cpState {
		inc := c.inconsistent ||
			(c.startLo != nil && c.startHi != nil && c.startLo.After(*c.startHi)) ||
			(c.endLo != nil && c.endHi != nil && c.endLo.After(*c.endHi)) ||
			(c.startLo != nil && c.endHi != nil && c.startLo.After(*c.endHi))
		out.CPs[id] = DerivedWindow{
			StartedAtLower: c.startLo,
			StartedAtUpper: c.startHi,
			EndedAtLower:   c.endLo,
			EndedAtUpper:   c.endHi,
			Inconsistent:   inc,
		}
	}
	for id, s := range stState {
		inc := s.inconsistent || (s.lo != nil && s.hi != nil && s.lo.After(*s.hi))
		out.Stations[id] = StationDerivedWindow{
			CapturedAtLower: s.lo,
			CapturedAtUpper: s.hi,
			Inconsistent:    inc,
		}
	}
	return out
}

// anyOpAffectsDateGraph returns true when a session's ops include at least
// one write that could change the propagation inputs (CP precise dates,
// station captured_at, or cp_observation rows). Solver-only writebacks
// touch est_*/σ and don't dirty the date graph, so we can skip the load
// and the whole pass.
func anyOpAffectsDateGraph(ops []journalOp) bool {
	for _, op := range ops {
		switch op.EntityType {
		case entityCPObservation, entityStation, entityControlPoint:
			return true
		}
	}
	return false
}

// recomputeAndJournalWindows is the merge-time entry point. Reads main
// (post-applyPlanToMain), runs propagateWindows, and emits journaled
// `update station` / `update control_point` ops for any row whose derived
// columns changed. Each op is also applied to main right away so the
// σ-gate check and downstream reads see the post-recompute state.
func recomputeAndJournalWindows(ctx context.Context, tx pgx.Tx, sessionID string, ops []journalOp) ([]journalOp, error) {
	if !anyOpAffectsDateGraph(ops) {
		return nil, nil
	}
	cps, err := loadAllControlPointsForPropagation(ctx, tx)
	if err != nil {
		return nil, err
	}
	stations, err := loadAllStationsForPropagation(ctx, tx)
	if err != nil {
		return nil, err
	}
	obs, err := loadAllCpObservationsForPropagation(ctx, tx)
	if err != nil {
		return nil, err
	}
	result := propagateWindows(cps, stations, obs)

	now := time.Now().UTC()
	added := make([]journalOp, 0)
	for i := range cps {
		cp := cps[i]
		fresh := result.CPs[cp.ID]
		if derivedWindowEqual(cp.DerivedWindow, fresh) {
			continue
		}
		before := jsonMust(cp)
		cp.DerivedWindow = fresh
		cp.UpdatedAt = now
		after := jsonMust(cp)
		if err := recordOp(ctx, tx, sessionID, entityControlPoint, cp.ID, "update", before, after); err != nil {
			return nil, err
		}
		if err := updateEntityFromJSON(ctx, tx, entityControlPoint, cp.ID, after); err != nil {
			return nil, err
		}
		added = append(added, journalOp{
			EntityType: entityControlPoint, EntityID: cp.ID, Op: "update",
			BeforeJSON: before, AfterJSON: after,
		})
	}
	for i := range stations {
		st := stations[i]
		fresh := result.Stations[st.ID]
		if stationDerivedWindowEqual(st.DerivedWindow, fresh) {
			continue
		}
		before := jsonMust(st)
		st.DerivedWindow = fresh
		st.UpdatedAt = now
		after := jsonMust(st)
		if err := recordOp(ctx, tx, sessionID, entityStation, st.ID, "update", before, after); err != nil {
			return nil, err
		}
		if err := updateEntityFromJSON(ctx, tx, entityStation, st.ID, after); err != nil {
			return nil, err
		}
		added = append(added, journalOp{
			EntityType: entityStation, EntityID: st.ID, Op: "update",
			BeforeJSON: before, AfterJSON: after,
		})
	}
	return added, nil
}

// propagateDatesInSession is the solve-time entry point. Reads main +
// session overlay so the propagation operates on the post-session-edit
// state the user is about to merge. Emits journaled update ops via
// recordOp; does NOT apply to main (the session journal carries the
// change until merge). Called from writebackChangesInSession right
// before tx.Commit so propagated bounds appear in the overlay alongside
// the solver's own est_*/σ writes.
func (s *Server) propagateDatesInSession(ctx context.Context, tx pgx.Tx, sessionID string, overlay sessionOverlay) error {
	cps, err := s.overlayedControlPoints(ctx, overlay)
	if err != nil {
		return err
	}
	stations, err := s.overlayedStations(ctx, overlay)
	if err != nil {
		return err
	}
	obs, err := s.overlayedCpObservations(ctx, overlay)
	if err != nil {
		return err
	}
	result := propagateWindows(cps, stations, obs)

	now := time.Now().UTC()
	for i := range cps {
		cp := cps[i]
		fresh := result.CPs[cp.ID]
		if derivedWindowEqual(cp.DerivedWindow, fresh) {
			continue
		}
		before := jsonMust(cp)
		cp.DerivedWindow = fresh
		cp.UpdatedAt = now
		after := jsonMust(cp)
		if err := recordOp(ctx, tx, sessionID, entityControlPoint, cp.ID, "update", before, after); err != nil {
			return err
		}
	}
	for i := range stations {
		st := stations[i]
		fresh := result.Stations[st.ID]
		if stationDerivedWindowEqual(st.DerivedWindow, fresh) {
			continue
		}
		before := jsonMust(st)
		st.DerivedWindow = fresh
		st.UpdatedAt = now
		after := jsonMust(st)
		if err := recordOp(ctx, tx, sessionID, entityStation, st.ID, "update", before, after); err != nil {
			return err
		}
	}
	return nil
}

// Full-graph read helpers — used by both merge-time and solve-time paths.
// The queryer interface lets us reuse the same code on a *pgxpool.Pool
// (overlay path) or a pgx.Tx (merge-time path).

func loadAllStationsForPropagation(ctx context.Context, q queryerLike) ([]Station, error) {
	rows, err := q.Query(ctx, `SELECT `+stationCols+` FROM stations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Station{}
	for rows.Next() {
		st, err := scanStation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

func loadAllControlPointsForPropagation(ctx context.Context, q queryerLike) ([]ControlPoint, error) {
	rows, err := q.Query(ctx, `SELECT `+controlPointCols+` FROM control_points`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ControlPoint{}
	for rows.Next() {
		cp, err := scanControlPoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, cp)
	}
	return out, rows.Err()
}

func loadAllCpObservationsForPropagation(ctx context.Context, q queryerLike) ([]CpObservation, error) {
	rows, err := q.Query(ctx, `SELECT `+cpObservationCols+` FROM cp_observations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CpObservation{}
	for rows.Next() {
		o, err := scanCpObservation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// overlayedX functions return the main rows with the session overlay
// applied — so a CP/station/observation that the session has staged-edited
// or staged-inserted reflects the post-session state.

func (s *Server) overlayedControlPoints(ctx context.Context, overlay sessionOverlay) ([]ControlPoint, error) {
	base, err := loadAllControlPointsForPropagation(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityControlPoint],
		func(cp ControlPoint) string { return cp.ID },
		decodeJSON[ControlPoint],
		func(ControlPoint) bool { return true })
}

func (s *Server) overlayedStations(ctx context.Context, overlay sessionOverlay) ([]Station, error) {
	base, err := loadAllStationsForPropagation(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityStation],
		func(st Station) string { return st.ID },
		decodeJSON[Station],
		func(Station) bool { return true })
}

func (s *Server) overlayedCpObservations(ctx context.Context, overlay sessionOverlay) ([]CpObservation, error) {
	base, err := loadAllCpObservationsForPropagation(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityCPObservation],
		func(o CpObservation) string { return o.ID },
		decodeJSON[CpObservation],
		func(CpObservation) bool { return true })
}

// --- Equality + pointer-math helpers (shared with the rest of the file).

func derivedWindowEqual(a, b DerivedWindow) bool {
	return a.Inconsistent == b.Inconsistent &&
		timePtrEqual(a.StartedAtLower, b.StartedAtLower) &&
		timePtrEqual(a.StartedAtUpper, b.StartedAtUpper) &&
		timePtrEqual(a.EndedAtLower, b.EndedAtLower) &&
		timePtrEqual(a.EndedAtUpper, b.EndedAtUpper)
}

func stationDerivedWindowEqual(a, b StationDerivedWindow) bool {
	return a.Inconsistent == b.Inconsistent &&
		timePtrEqual(a.CapturedAtLower, b.CapturedAtLower) &&
		timePtrEqual(a.CapturedAtUpper, b.CapturedAtUpper)
}

func minPtr(a, b *time.Time) *time.Time {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	if b.Before(*a) {
		return b
	}
	return a
}

func maxPtr(a, b *time.Time) *time.Time {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	if b.After(*a) {
		return b
	}
	return a
}
