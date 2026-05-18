package main

import (
	"context"
	"fmt"
	"time"

	"github.com/bmander/panorama-builder/backend/stn"
	"github.com/jackc/pgx/v5"
)

// derived_window.go materializes implicit lifespan bounds on control_points
// AND capture-time bounds on stations from the observation graph.
//
// The constraint model maps onto the bound-propagation engine in
// backend/stn/:
//   - Each CP contributes two interval variables (started_at, ended_at)
//     plus a lifespan-validity Leq enforcing started ≤ ended.
//   - Each station contributes one interval variable (captured_at).
//   - Each `observed` cp_observation adds two Leqs encoding
//     c.started ≤ s.captured ≤ c.ended.
//   - Each `missing` cp_observation adds a Disjunction of two Leqs
//     encoding s.captured ≤ c.started OR c.ended ≤ s.captured
//     (Leq-relaxed strict inequalities, narrowed via dominated-branch
//     pruning).
//
// Time domain is int64 unix nanoseconds — converted from *time.Time at
// the API boundary so the engine can stay generic over cmp.Ordered.
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
	solver := stn.New[int64]()

	type cpVars struct{ start, end int }
	cpV := make(map[string]cpVars, len(cps))
	stV := make(map[string]int, len(stations))

	// Seed each entity's variables from precise dates. Null inputs leave
	// both bounds nil (unbounded).
	for _, cp := range cps {
		sIdx := solver.AddVar()
		eIdx := solver.AddVar()
		cpV[cp.ID] = cpVars{sIdx, eIdx}
		vars := solver.Variables()
		vars[sIdx].Lo, vars[sIdx].Hi = toNanos(cp.StartedAt), toNanos(cp.StartedAt)
		vars[eIdx].Lo, vars[eIdx].Hi = toNanos(cp.EndedAt), toNanos(cp.EndedAt)
		solver.AddConstraint(stn.Leq[int64]{A: sIdx, B: eIdx})
	}
	for _, st := range stations {
		tIdx := solver.AddVar()
		stV[st.ID] = tIdx
		vars := solver.Variables()
		vars[tIdx].Lo, vars[tIdx].Hi = toNanos(st.CapturedAt), toNanos(st.CapturedAt)
	}

	// One constraint per observation.
	for _, o := range obs {
		ti, sOK := stV[o.StationID]
		cv, cOK := cpV[o.ControlPointID]
		if !sOK || !cOK {
			continue
		}
		switch o.Status {
		case Observed:
			// c.started ≤ s.captured ≤ c.ended
			solver.AddConstraint(stn.Leq[int64]{A: cv.start, B: ti})
			solver.AddConstraint(stn.Leq[int64]{A: ti, B: cv.end})
		case Missing:
			// s.captured < c.started  OR  c.ended < s.captured  (Leq-relaxed)
			solver.AddConstraint(stn.Disjunction[int64]{
				Alts: []stn.Constraint[int64]{
					stn.Leq[int64]{A: ti, B: cv.start},
					stn.Leq[int64]{A: cv.end, B: ti},
				},
			})
		}
	}

	solver.Propagate()

	// Read each variable's narrowed bounds back into the time-shaped output.
	vars := solver.Variables()
	out := propagatedWindows{
		CPs:      make(map[string]DerivedWindow, len(cps)),
		Stations: make(map[string]StationDerivedWindow, len(stations)),
	}
	for _, cp := range cps {
		v := cpV[cp.ID]
		sv, ev := vars[v.start], vars[v.end]
		out.CPs[cp.ID] = DerivedWindow{
			StartedAtLower: fromNanos(sv.Lo),
			StartedAtUpper: fromNanos(sv.Hi),
			EndedAtLower:   fromNanos(ev.Lo),
			EndedAtUpper:   fromNanos(ev.Hi),
			Inconsistent:   sv.Inconsistent || ev.Inconsistent,
		}
	}
	for _, st := range stations {
		tv := vars[stV[st.ID]]
		out.Stations[st.ID] = StationDerivedWindow{
			CapturedAtLower: fromNanos(tv.Lo),
			CapturedAtUpper: fromNanos(tv.Hi),
			Inconsistent:    tv.Inconsistent,
		}
	}
	return out
}

func toNanos(t *time.Time) *int64 {
	if t == nil {
		return nil
	}
	n := t.UnixNano()
	return &n
}

func fromNanos(p *int64) *time.Time {
	if p == nil {
		return nil
	}
	t := time.Unix(0, *p).UTC()
	return &t
}

// isDateGraphEntity reports whether mutations to this entity type feed
// the STN propagator (precise dates, captured_at, cp_observation rows).
// Other entity kinds (photo, image_measurement, cp_constraint, cp_surface)
// don't contribute and can skip propagation outright.
func isDateGraphEntity(entityType string) bool {
	switch entityType {
	case entityCPObservation, entityStation, entityControlPoint:
		return true
	}
	return false
}

// anyOpAffectsDateGraph returns true when a session's ops include at least
// one write that could change the propagation inputs. Solver-only
// writebacks touch est_*/σ and don't dirty the date graph, so we can
// skip the load and the whole pass.
func anyOpAffectsDateGraph(ops []journalOp) bool {
	for _, op := range ops {
		if isDateGraphEntity(op.EntityType) {
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
	cps, err := loadAllOrderedByID(ctx, tx, controlPointCols, "control_points", scanControlPoint)
	if err != nil {
		return nil, err
	}
	stations, err := loadAllOrderedByID(ctx, tx, stationCols, "stations", scanStation)
	if err != nil {
		return nil, err
	}
	obs, err := loadAllOrderedByID(ctx, tx, cpObservationCols, "cp_observations", scanCpObservation)
	if err != nil {
		return nil, err
	}
	result := propagateWindows(cps, stations, obs)

	now := time.Now().UTC()
	added := make([]journalOp, 0, len(cps)+len(stations))
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
// session overlay through the writeback tx (so reads share one
// connection with the solver's own pending writes) and journals update
// ops via recordOp; does NOT apply to main (the session journal carries
// the change until merge). Called from writebackChangesInSession right
// before tx.Commit so propagated bounds appear in the overlay alongside
// the solver's own est_*/σ writes.
//
// Skipped entirely when the overlay carries no staged edits to date-graph
// inputs: a pure-solver session can't change any derived bound, so the
// load+propagate work would always be a no-op.
func propagateDatesInSession(ctx context.Context, tx pgx.Tx, sessionID string, overlay sessionOverlay) error {
	if !overlayAffectsDateGraph(overlay) {
		return nil
	}
	cps, err := overlayedAll(ctx, tx, controlPointCols, "control_points",
		scanControlPoint, overlay[entityControlPoint],
		func(cp ControlPoint) string { return cp.ID })
	if err != nil {
		return err
	}
	stations, err := overlayedAll(ctx, tx, stationCols, "stations",
		scanStation, overlay[entityStation],
		func(st Station) string { return st.ID })
	if err != nil {
		return err
	}
	obs, err := overlayedAll(ctx, tx, cpObservationCols, "cp_observations",
		scanCpObservation, overlay[entityCPObservation],
		func(o CpObservation) string { return o.ID })
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

// runPropagationInTx reloads the overlay from `tx` so the propagator
// sees ops just written through the same tx — the pre-tx overlay would
// either miss the new op (single-op handlers) or serialize stale
// full-row JSON (solver writeback would silently overwrite est_*/σ).
func runPropagationInTx(ctx context.Context, tx pgx.Tx, sessionID string) error {
	overlay, err := loadSessionOverlay(ctx, tx, sessionID)
	if err != nil {
		return fmt.Errorf("reload overlay: %w", err)
	}
	if err := propagateDatesInSession(ctx, tx, sessionID, overlay); err != nil {
		return fmt.Errorf("propagate dates: %w", err)
	}
	return nil
}

// overlayAffectsDateGraph is the solve-time analogue to
// anyOpAffectsDateGraph — fast path that lets a pure-solver writeback
// skip the propagation entirely. Solver changes only touch est_*/σ, not
// date-graph inputs, so a session with no staged station/CP/observation
// edits cannot have moved any derived bound.
func overlayAffectsDateGraph(overlay sessionOverlay) bool {
	return len(overlay[entityStation]) > 0 ||
		len(overlay[entityControlPoint]) > 0 ||
		len(overlay[entityCPObservation]) > 0
}

// loadAllOrderedByID scans every row of a table in deterministic id order.
// Used by the propagation pass on both code paths. ORDER BY id keeps the
// emitted op stream stable across runs — same inputs produce the same
// journaled sequence, which matters for human-readable commit diffs.
func loadAllOrderedByID[T any](
	ctx context.Context, q queryerLike, cols, table string,
	scan func(pgx.Row) (T, error),
) ([]T, error) {
	rows, err := q.Query(ctx, `SELECT `+cols+` FROM `+table+` ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// overlayedAll wraps loadAllOrderedByID with the session-overlay merge
// step. Returns the main rows with any staged session edits applied —
// session-pending CPs/stations/observations show their post-edit state.
func overlayedAll[T any](
	ctx context.Context, q queryerLike, cols, table string,
	scan func(pgx.Row) (T, error),
	bucket map[string]entityState,
	idOf func(T) string,
) ([]T, error) {
	base, err := loadAllOrderedByID(ctx, q, cols, table, scan)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, bucket, idOf, decodeJSON[T], func(T) bool { return true })
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
