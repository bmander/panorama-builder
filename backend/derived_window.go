package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

// derived_window.go materializes implicit lifespan bounds on control_points
// from the observation graph.
//
// Inputs:
//   - control_points.started_at / ended_at  (precise, certain events)
//   - cp_observations(status, station, cp)
//   - stations.captured_at                  (NULL = unknown, skipped)
//
// Outputs (per CP, written to control_points.{started_at_lower,
// started_at_upper, ended_at_lower, ended_at_upper, derivation_inconsistent}):
//
//   - started_upper = min(precise_started, S(s) for s ∈ obs, miss-upper)
//   - started_lower = max(precise_started, miss-lower)
//   - ended_upper   = min(precise_ended,   miss-upper)
//   - ended_lower   = max(precise_ended,   S(s) for s ∈ obs, miss-lower)
//
// "miss-lower" / "miss-upper": for each missing observation m with
// S(m) ≠ NULL, if some observed station t has S(t) > S(m) then started_lower
// ≥ S(m) (CP didn't exist yet at S(m)); if S(t) < S(m) then ended_upper ≤
// S(m) (CP destroyed by S(m)). Both holding for the same m sets
// derivation_inconsistent=true.
//
// Recomputation runs at merge time: collectDirtyCPs scans the just-applied
// session ops, recomputeAndJournal computes fresh bounds for each, and any
// CP whose row changed gets a journaled `update control_points` op so the
// commit is self-contained for revert.

// recomputeAndJournalCPWindows is the entry point called from mergeSession
// after applyPlanToMain. It returns the additional ops (already coalesced
// into session_ops via recordOp) so the caller can extend its plan.
//
// Reads are batched: one query loads every dirty CP row, a second loads
// every observation+station_captured_at across the dirty set. Per-CP
// computation then runs in memory.
func recomputeAndJournalCPWindows(ctx context.Context, tx pgx.Tx, sessionID string, ops []journalOp) ([]journalOp, error) {
	dirty, err := collectDirtyCPs(ctx, tx, ops)
	if err != nil {
		return nil, err
	}
	if len(dirty) == 0 {
		return nil, nil
	}

	cps, err := loadControlPointsTx(ctx, tx, dirty)
	if err != nil {
		return nil, err
	}
	obs, err := loadObservationsByCPTx(ctx, tx, dirty)
	if err != nil {
		return nil, err
	}

	added := make([]journalOp, 0, len(cps))
	for _, cp := range cps {
		fresh := computeWindowFromInputs(cp.StartedAt, cp.EndedAt, obs[cp.ID])
		if derivedWindowEqual(cp.DerivedWindow, fresh) {
			continue
		}
		before := jsonMust(cp)
		cp.DerivedWindow = fresh
		cp.UpdatedAt = time.Now().UTC()
		after := jsonMust(cp)
		if err := recordOp(ctx, tx, sessionID, entityControlPoint, cp.ID, "update", before, after); err != nil {
			return nil, err
		}
		// Apply the recompute to main right now so subsequent operations
		// (mergeGateCheck, bumpEntityCommits, follow-on revert reads) see
		// the post-recompute state.
		if err := updateEntityFromJSON(ctx, tx, entityControlPoint, cp.ID, after); err != nil {
			return nil, err
		}
		added = append(added, journalOp{
			EntityType: entityControlPoint,
			EntityID:   cp.ID,
			Op:         "update",
			BeforeJSON: before,
			AfterJSON:  after,
		})
	}
	return added, nil
}

// collectDirtyCPs returns every control_point id whose derived window
// might be affected by the just-applied set of journal ops.
//   - any cp_observation op → its control_point_id
//   - any station op that may have changed captured_at → all CPs
//     observed/missing at that station (precise dates seed bounds, so a
//     station whose date moved invalidates every CP it touches)
//   - any control_point op whose precise dates were the inputs we'd seeded
//     into the derived window — but the user write doesn't carry the new
//     derived bounds; recompute lets us rebuild them from observations.
func collectDirtyCPs(ctx context.Context, tx pgx.Tx, ops []journalOp) ([]string, error) {
	dirty := map[string]struct{}{}
	dirtyStations := map[string]struct{}{}
	for _, op := range ops {
		switch op.EntityType {
		case entityCPObservation:
			cpID, err := cpIDFromObservationOp(op)
			if err != nil {
				return nil, err
			}
			if cpID != "" {
				dirty[cpID] = struct{}{}
			}
		case entityStation:
			dirtyStations[op.EntityID] = struct{}{}
		case entityControlPoint:
			dirty[op.EntityID] = struct{}{}
		}
	}
	if len(dirtyStations) > 0 {
		ids := make([]string, 0, len(dirtyStations))
		for id := range dirtyStations {
			ids = append(ids, id)
		}
		rows, err := tx.Query(ctx,
			`SELECT DISTINCT control_point_id FROM cp_observations WHERE station_id = ANY($1)`, ids)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var cpID string
			if err := rows.Scan(&cpID); err != nil {
				return nil, err
			}
			dirty[cpID] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	out := make([]string, 0, len(dirty))
	for id := range dirty {
		out = append(out, id)
	}
	return out, nil
}

// cpIDFromObservationOp extracts control_point_id from either side of the
// op. After-state is preferred; before-state covers deletes.
func cpIDFromObservationOp(op journalOp) (string, error) {
	body := op.AfterJSON
	if len(body) == 0 {
		body = op.BeforeJSON
	}
	if len(body) == 0 {
		return "", nil
	}
	var o CpObservation
	if err := json.Unmarshal(body, &o); err != nil {
		return "", err
	}
	return o.ControlPointID, nil
}

// loadControlPointsTx scans the given CP ids in a single query, returning
// them in input order with missing ids silently dropped (those CPs got
// deleted in this session).
func loadControlPointsTx(ctx context.Context, tx pgx.Tx, ids []string) ([]ControlPoint, error) {
	rows, err := tx.Query(ctx,
		`SELECT `+controlPointCols+` FROM control_points WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ControlPoint, 0, len(ids))
	for rows.Next() {
		cp, err := scanControlPoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, cp)
	}
	return out, rows.Err()
}

// cpObservationInput is one (status, station-captured-at) pair per
// observation referencing a CP. captured_at NULL means the station's
// date is unknown; we skip those in the rule set.
type cpObservationInput struct {
	status   string
	captured *time.Time
}

// loadObservationsByCPTx returns every observation referencing any of the
// given CP ids, bucketed by control_point_id.
func loadObservationsByCPTx(ctx context.Context, tx pgx.Tx, ids []string) (map[string][]cpObservationInput, error) {
	rows, err := tx.Query(ctx, `
		SELECT o.control_point_id, o.status, s.captured_at
		FROM cp_observations o
		JOIN stations s ON s.id = o.station_id
		WHERE o.control_point_id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]cpObservationInput{}
	for rows.Next() {
		var cpID string
		var in cpObservationInput
		if err := rows.Scan(&cpID, &in.status, &in.captured); err != nil {
			return nil, err
		}
		out[cpID] = append(out[cpID], in)
	}
	return out, rows.Err()
}

// computeWindowFromInputs runs the rule set above for one CP given its
// precise dates and the observations-with-station-dates referencing it.
// Pure function; no I/O.
func computeWindowFromInputs(preciseStart, preciseEnd *time.Time, obs []cpObservationInput) DerivedWindow {
	var observedDates, missingDates []time.Time
	for _, in := range obs {
		if in.captured == nil {
			continue
		}
		switch in.status {
		case "observed":
			observedDates = append(observedDates, *in.captured)
		case "missing":
			missingDates = append(missingDates, *in.captured)
		}
	}

	// Precise dates seed both sides of their bound.
	win := DerivedWindow{
		StartedAtLower: preciseStart,
		StartedAtUpper: preciseStart,
		EndedAtLower:   preciseEnd,
		EndedAtUpper:   preciseEnd,
	}

	// Each observed date pulls started_upper down and ended_lower up.
	for i := range observedDates {
		t := observedDates[i]
		win.StartedAtUpper = minPtr(win.StartedAtUpper, &t)
		win.EndedAtLower = maxPtr(win.EndedAtLower, &t)
	}

	// Disambiguate each missing observation against the observed set.
	for i := range missingDates {
		m := missingDates[i]
		var hasLater, hasEarlier bool
		for _, o := range observedDates {
			if o.After(m) {
				hasLater = true
			}
			if o.Before(m) {
				hasEarlier = true
			}
		}
		if hasLater && hasEarlier {
			// Both directions can't be true — the missing observation is
			// inside the observed envelope.
			win.Inconsistent = true
		}
		if hasLater {
			win.StartedAtLower = maxPtr(win.StartedAtLower, &m)
		}
		if hasEarlier {
			win.EndedAtUpper = minPtr(win.EndedAtUpper, &m)
		}
		// Neither direction → unattributable; contributes nothing.
	}

	return win
}

func derivedWindowEqual(a, b DerivedWindow) bool {
	return a.Inconsistent == b.Inconsistent &&
		timePtrEqual(a.StartedAtLower, b.StartedAtLower) &&
		timePtrEqual(a.StartedAtUpper, b.StartedAtUpper) &&
		timePtrEqual(a.EndedAtLower, b.EndedAtLower) &&
		timePtrEqual(a.EndedAtUpper, b.EndedAtUpper)
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
