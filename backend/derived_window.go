package main

import (
	"context"
	"fmt"
	"net/http"
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

type cpVars struct{ start, end int }

// constraintKind tags each stn constraint with its domain meaning so a
// post-propagation walk can produce human-readable contradiction reports.
type constraintKind int

const (
	kindLifespanValidity constraintKind = iota // CP: started_at ≤ ended_at
	kindObservedStart                          // Station observed CP: c.started ≤ s.captured
	kindObservedEnd                            // Station observed CP: s.captured ≤ c.ended
	kindMissing                                // Station marked CP missing (disjunction)
)

type constraintCtx struct {
	kind      constraintKind
	cpID      string
	stationID string // empty for kindLifespanValidity
}

// dateGraph bundles the seeded solver with the entity-to-variable maps,
// the parallel constraint-context slice, and a reverse map from variable
// index back to entity. propagateWindows uses it to read out propagated
// bounds; explainInconsistency uses it to attribute post-propagation
// infeasibilities back to specific (cp, station, kind) triples.
type dateGraph struct {
	solver   *stn.Solver[int64]
	cpV      map[string]cpVars
	stV      map[string]int
	ctxs     []constraintCtx // parallel to solver.Constraints()
	varOwner []varOwnerInfo  // indexed by stn variable id
}

// varOwnerInfo identifies which entity + which date field a given stn
// variable corresponds to, supporting O(1) reverse lookup from a bound
// reference back to a human-readable identity.
type varOwnerInfo struct {
	entityID string
	field    string // "started_at" | "ended_at" | "captured_at"
	isCP     bool
}

func (g *dateGraph) addConstraint(c stn.Constraint[int64], ctx constraintCtx) {
	g.solver.AddConstraint(c)
	g.ctxs = append(g.ctxs, ctx)
}

func (g *dateGraph) addCP(cp ControlPoint) {
	sIdx := g.solver.AddVar()
	eIdx := g.solver.AddVar()
	g.cpV[cp.ID] = cpVars{sIdx, eIdx}
	g.varOwner = append(g.varOwner,
		varOwnerInfo{entityID: cp.ID, field: "started_at", isCP: true},
		varOwnerInfo{entityID: cp.ID, field: "ended_at", isCP: true},
	)
	vars := g.solver.Variables()
	vars[sIdx].Lo, vars[sIdx].Hi = toNanos(cp.StartedAt), toNanos(cp.StartedAt)
	vars[eIdx].Lo, vars[eIdx].Hi = toNanos(cp.EndedAt), toNanos(cp.EndedAt)
	g.addConstraint(stn.Leq[int64]{A: sIdx, B: eIdx},
		constraintCtx{kind: kindLifespanValidity, cpID: cp.ID})
}

func (g *dateGraph) addStation(st Station) {
	tIdx := g.solver.AddVar()
	g.stV[st.ID] = tIdx
	g.varOwner = append(g.varOwner,
		varOwnerInfo{entityID: st.ID, field: "captured_at", isCP: false})
	vars := g.solver.Variables()
	vars[tIdx].Lo, vars[tIdx].Hi = toNanos(st.CapturedAt), toNanos(st.CapturedAt)
}

func buildDateGraph(cps []ControlPoint, stations []Station, obs []CpObservation) *dateGraph {
	g := &dateGraph{
		solver: stn.New[int64](),
		cpV:    make(map[string]cpVars, len(cps)),
		stV:    make(map[string]int, len(stations)),
	}
	for _, cp := range cps {
		g.addCP(cp)
	}
	for _, st := range stations {
		g.addStation(st)
	}
	for _, o := range obs {
		ti, sOK := g.stV[o.StationID]
		cv, cOK := g.cpV[o.ControlPointID]
		if !sOK || !cOK {
			continue
		}
		switch o.Status {
		case Present:
			g.addConstraint(stn.Leq[int64]{A: cv.start, B: ti},
				constraintCtx{kind: kindObservedStart, cpID: o.ControlPointID, stationID: o.StationID})
			g.addConstraint(stn.Leq[int64]{A: ti, B: cv.end},
				constraintCtx{kind: kindObservedEnd, cpID: o.ControlPointID, stationID: o.StationID})
		case Absent:
			g.addConstraint(stn.Disjunction[int64]{Alts: []stn.Constraint[int64]{
				stn.Leq[int64]{A: ti, B: cv.start},
				stn.Leq[int64]{A: cv.end, B: ti},
			}}, constraintCtx{kind: kindMissing, cpID: o.ControlPointID, stationID: o.StationID})
		}
	}
	return g
}

// propagateWindows runs the STN bound-propagation to quiescence on the
// supplied graph state. Pure function — no I/O.
func propagateWindows(cps []ControlPoint, stations []Station, obs []CpObservation) propagatedWindows {
	g := buildDateGraph(cps, stations, obs)
	g.solver.Propagate()

	vars := g.solver.Variables()
	out := propagatedWindows{
		CPs:      make(map[string]DerivedWindow, len(cps)),
		Stations: make(map[string]StationDerivedWindow, len(stations)),
	}
	for _, cp := range cps {
		v := g.cpV[cp.ID]
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
		tv := vars[g.stV[st.ID]]
		out.Stations[st.ID] = StationDerivedWindow{
			CapturedAtLower: fromNanos(tv.Lo),
			CapturedAtUpper: fromNanos(tv.Hi),
			Inconsistent:    tv.Inconsistent,
		}
	}
	return out
}

// explainStationInconsistency enumerates the constraints touching the
// station's capture-time variable that remain infeasible under the
// propagated bounds. The second return is false when the station isn't
// in the supplied set; when true, a non-nil (possibly empty) slice is
// returned.
func explainStationInconsistency(stationID string, cps []ControlPoint, stations []Station, obs []CpObservation) ([]InconsistencyReason, bool) {
	g := buildDateGraph(cps, stations, obs)
	g.solver.Propagate()
	v, ok := g.stV[stationID]
	if !ok {
		return nil, false
	}
	return collectReasons(g, map[int]bool{v: true}, cps, stations), true
}

// explainControlPointInconsistency is the CP-side counterpart, gathering
// reasons against both lifespan-endpoint variables.
func explainControlPointInconsistency(cpID string, cps []ControlPoint, stations []Station, obs []CpObservation) ([]InconsistencyReason, bool) {
	g := buildDateGraph(cps, stations, obs)
	g.solver.Propagate()
	v, ok := g.cpV[cpID]
	if !ok {
		return nil, false
	}
	return collectReasons(g, map[int]bool{v.start: true, v.end: true}, cps, stations), true
}

type boundSide int

const (
	boundLo boundSide = iota
	boundHi
)

// boundRef names one specific bound on one variable. describeContradiction
// emits these so collectReasons can walk per-bound blame to identify the
// upstream constraint that produced each cited value.
type boundRef struct {
	varIdx int
	side   boundSide
}

type contradiction struct {
	text  string
	cited []boundRef
}

func collectReasons(g *dateGraph, targetVars map[int]bool, cps []ControlPoint, stations []Station) []InconsistencyReason {
	cpByID := make(map[string]ControlPoint, len(cps))
	for _, cp := range cps {
		cpByID[cp.ID] = cp
	}
	stByID := make(map[string]Station, len(stations))
	for _, st := range stations {
		stByID[st.ID] = st
	}

	vars := g.solver.Variables()
	reasons := []InconsistencyReason{}
	for ci, c := range g.solver.Constraints() {
		touches := false
		for _, vi := range c.Variables() {
			if targetVars[vi] {
				touches = true
				break
			}
		}
		if !touches || c.Feasible(vars) {
			continue
		}
		con := describeContradiction(g.ctxs[ci], cpByID, stByID, vars, g.cpV, g.stV)
		sources := []string{}
		seen := map[boundRef]bool{}
		for _, ref := range con.cited {
			if seen[ref] {
				continue
			}
			seen[ref] = true
			sources = append(sources, describeBoundSource(ref, g, cpByID, stByID))
		}
		reasons = append(reasons, InconsistencyReason{Text: con.text, BoundSources: sources})
	}
	return reasons
}

func describeContradiction(
	ctx constraintCtx,
	cps map[string]ControlPoint, stations map[string]Station,
	vars []*stn.Variable[int64],
	cpV map[string]cpVars, stV map[string]int,
) contradiction {
	cp := cps[ctx.cpID]
	cpDesc := controlPointLabel(cp)
	cv := cpV[ctx.cpID]
	cpStart, cpEnd := vars[cv.start], vars[cv.end]

	switch ctx.kind {
	case kindLifespanValidity:
		return contradiction{
			text: fmt.Sprintf("CP %q: started_at lower bound (%s) is after ended_at upper bound (%s)",
				cpDesc, fmtBound(cpStart.Lo), fmtBound(cpEnd.Hi)),
			cited: []boundRef{{cv.start, boundLo}, {cv.end, boundHi}},
		}
	case kindObservedStart:
		st := stations[ctx.stationID]
		sIdx := stV[ctx.stationID]
		sv := vars[sIdx]
		return contradiction{
			text: fmt.Sprintf("Station %q observed CP %q: requires CP started_at ≤ station captured_at, but started_at lower bound (%s) exceeds captured_at upper bound (%s)",
				stationDisplayName(st), cpDesc, fmtBound(cpStart.Lo), fmtBound(sv.Hi)),
			cited: []boundRef{{cv.start, boundLo}, {sIdx, boundHi}},
		}
	case kindObservedEnd:
		st := stations[ctx.stationID]
		sIdx := stV[ctx.stationID]
		sv := vars[sIdx]
		return contradiction{
			text: fmt.Sprintf("Station %q observed CP %q: requires station captured_at ≤ CP ended_at, but captured_at lower bound (%s) exceeds ended_at upper bound (%s)",
				stationDisplayName(st), cpDesc, fmtBound(sv.Lo), fmtBound(cpEnd.Hi)),
			cited: []boundRef{{sIdx, boundLo}, {cv.end, boundHi}},
		}
	case kindMissing:
		st := stations[ctx.stationID]
		sIdx := stV[ctx.stationID]
		sv := vars[sIdx]
		return contradiction{
			text: fmt.Sprintf("Station %q marked CP %q missing: requires captured_at < CP started_at or > CP ended_at, but station window (%s – %s) overlaps CP lifespan (%s – %s) on both sides",
				stationDisplayName(st), cpDesc, fmtBound(sv.Lo), fmtBound(sv.Hi), fmtBound(cpStart.Lo), fmtBound(cpEnd.Hi)),
			cited: []boundRef{{sIdx, boundLo}, {sIdx, boundHi}, {cv.start, boundHi}, {cv.end, boundLo}},
		}
	}
	return contradiction{}
}

// describeConstraintRole formats a constraint by its observation kind
// alone, without any violation phrasing. Used as the "set by" attribution
// for a bound that some upstream constraint narrowed.
func describeConstraintRole(ctx constraintCtx, cps map[string]ControlPoint, stations map[string]Station) string {
	cpDesc := controlPointLabel(cps[ctx.cpID])
	switch ctx.kind {
	case kindLifespanValidity:
		return fmt.Sprintf("CP %q lifespan validity (started_at ≤ ended_at)", cpDesc)
	case kindObservedStart, kindObservedEnd:
		return fmt.Sprintf("Station %q observed CP %q", stationDisplayName(stations[ctx.stationID]), cpDesc)
	case kindMissing:
		return fmt.Sprintf("Station %q marked CP %q missing", stationDisplayName(stations[ctx.stationID]), cpDesc)
	}
	return "(unknown constraint)"
}

// describeBoundSource formats one cited bound: its identity (which entity
// + side), its current value, and the constraint or seed that set it.
func describeBoundSource(ref boundRef, g *dateGraph, cps map[string]ControlPoint, stations map[string]Station) string {
	v := g.solver.Variables()[ref.varIdx]
	var p *int64
	var blame int
	if ref.side == boundLo {
		p, blame = v.Lo, v.LoBlame
	} else {
		p, blame = v.Hi, v.HiBlame
	}
	name, seedField := boundIdentity(ref, g, cps, stations)

	var origin string
	switch {
	case blame >= 0:
		origin = describeConstraintRole(g.ctxs[blame], cps, stations)
	case p == nil:
		origin = "unbounded — no precise value, no narrowing"
	default:
		origin = fmt.Sprintf("precise %s", seedField)
	}
	return fmt.Sprintf("%s (%s): %s", name, fmtBound(p), origin)
}

// boundIdentity returns (display name, seed-field name) for the bound
// referenced by ref, via the dateGraph's precomputed reverse map.
// seedField is "started_at" / "ended_at" / "captured_at" so callers
// can say "precise <field>".
func boundIdentity(ref boundRef, g *dateGraph, cps map[string]ControlPoint, stations map[string]Station) (string, string) {
	side := "lower"
	if ref.side == boundHi {
		side = "upper"
	}
	o := g.varOwner[ref.varIdx]
	if o.isCP {
		return fmt.Sprintf("CP %q %s %s bound", controlPointLabel(cps[o.entityID]), o.field, side), o.field
	}
	return fmt.Sprintf("Station %q %s %s bound", stationDisplayName(stations[o.entityID]), o.field, side), o.field
}

func controlPointLabel(cp ControlPoint) string {
	if cp.Description != "" {
		return cp.Description
	}
	return cp.ID
}

func stationDisplayName(st Station) string {
	if st.Name != nil && *st.Name != "" {
		return *st.Name
	}
	return st.ID
}

// fmtBound renders a propagated bound as a short date string, falling
// back to year-only when the value lands on midnight Jan 1 UTC (matching
// the frontend's formatImpreciseDate convention for date-only seeds).
func fmtBound(p *int64) string {
	if p == nil {
		return "unbounded"
	}
	t := time.Unix(0, *p).UTC()
	if t.Month() == time.January && t.Day() == 1 &&
		t.Hour() == 0 && t.Minute() == 0 && t.Second() == 0 && t.Nanosecond() == 0 {
		return t.Format("2006")
	}
	return t.Format("2006-01-02")
}

// respondInconsistencyReasons is the shared body of the station and CP
// inconsistency-reasons handlers. The explain callback differs only in
// which entity-type's variable(s) the violation walk targets.
func (s *Server) respondInconsistencyReasons(
	w http.ResponseWriter, r *http.Request,
	explain func(id string, cps []ControlPoint, stations []Station, obs []CpObservation) ([]InconsistencyReason, bool),
) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	overlay, ok := s.maybeOverlay(w, r)
	if !ok {
		return
	}
	cps, stations, obs, err := loadDateGraphInputs(r.Context(), s.db, overlay)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	reasons, found := explain(id, cps, stations, obs)
	if !found {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, InconsistencyReasons{Reasons: reasons})
}

// loadDateGraphInputs reads the cps + stations + cp_observations the
// propagator needs. When overlay is non-nil, session-staged edits are
// merged in so the result reflects what the user sees in the page.
func loadDateGraphInputs(ctx context.Context, q queryerLike, overlay sessionOverlay) (
	[]ControlPoint, []Station, []CpObservation, error,
) {
	if overlay != nil {
		cps, err := overlayedAll(ctx, q, controlPointCols, "control_points",
			scanControlPoint, overlay[entityControlPoint],
			func(cp ControlPoint) string { return cp.ID })
		if err != nil {
			return nil, nil, nil, err
		}
		stations, err := overlayedAll(ctx, q, stationCols, "stations",
			scanStation, overlay[entityStation],
			func(st Station) string { return st.ID })
		if err != nil {
			return nil, nil, nil, err
		}
		obs, err := overlayedAll(ctx, q, cpObservationCols, "cp_observations",
			scanCpObservation, overlay[entityCPObservation],
			func(o CpObservation) string { return o.ID })
		if err != nil {
			return nil, nil, nil, err
		}
		return cps, stations, obs, nil
	}
	cps, err := loadAllOrderedByID(ctx, q, controlPointCols, "control_points", scanControlPoint)
	if err != nil {
		return nil, nil, nil, err
	}
	stations, err := loadAllOrderedByID(ctx, q, stationCols, "stations", scanStation)
	if err != nil {
		return nil, nil, nil, err
	}
	obs, err := loadAllOrderedByID(ctx, q, cpObservationCols, "cp_observations", scanCpObservation)
	if err != nil {
		return nil, nil, nil, err
	}
	return cps, stations, obs, nil
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
	if spec, ok := entityRegistry[entityType]; ok {
		return spec.feedsDateGraph()
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
