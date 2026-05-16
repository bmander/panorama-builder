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
func recomputeAndJournalCPWindows(ctx context.Context, tx pgx.Tx, sessionID string, ops []journalOp) ([]journalOp, error) {
	dirty, err := collectDirtyCPs(ctx, tx, ops)
	if err != nil {
		return nil, err
	}
	if len(dirty) == 0 {
		return nil, nil
	}

	added := make([]journalOp, 0)
	for _, cpID := range dirty {
		cp, present, err := loadControlPointTx(ctx, tx, cpID)
		if err != nil {
			return nil, err
		}
		if !present {
			// CP got deleted in this session; nothing to recompute.
			continue
		}
		fresh, err := computeCPDerivedWindow(ctx, tx, cpID, cp.StartedAt, cp.EndedAt)
		if err != nil {
			return nil, err
		}
		if derivedWindowEqual(cp.DerivedWindow, fresh) {
			continue
		}
		before := jsonMust(cp)
		cp.DerivedWindow = fresh
		cp.UpdatedAt = time.Now().UTC()
		after := jsonMust(cp)
		if err := recordOp(ctx, tx, sessionID, entityControlPoint, cpID, "update", before, after); err != nil {
			return nil, err
		}
		// Apply the recompute to main right now so subsequent operations
		// (mergeGateCheck, bumpEntityCommits, follow-on revert reads) see
		// the post-recompute state.
		if err := updateEntityFromJSON(ctx, tx, entityControlPoint, cpID, after); err != nil {
			return nil, err
		}
		added = append(added, journalOp{
			EntityType: entityControlPoint,
			EntityID:   cpID,
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

// loadControlPointTx scans a single CP row from main inside a transaction.
func loadControlPointTx(ctx context.Context, tx pgx.Tx, id string) (ControlPoint, bool, error) {
	cp, err := scanControlPoint(tx.QueryRow(ctx,
		`SELECT `+controlPointCols+` FROM control_points WHERE id=$1`, id))
	if err != nil {
		if err == pgx.ErrNoRows {
			return ControlPoint{}, false, nil
		}
		return ControlPoint{}, false, err
	}
	return cp, true, nil
}

// computeCPDerivedWindow runs the rule set above for one CP, given its
// precise dates. Reads cp_observations + stations from the supplied tx.
func computeCPDerivedWindow(ctx context.Context, tx pgx.Tx, cpID string, preciseStart, preciseEnd *time.Time) (DerivedWindow, error) {
	rows, err := tx.Query(ctx, `
		SELECT o.status, s.captured_at
		FROM cp_observations o
		JOIN stations s ON s.id = o.station_id
		WHERE o.control_point_id = $1`, cpID)
	if err != nil {
		return DerivedWindow{}, err
	}
	defer rows.Close()

	var observedDates, missingDates []time.Time
	for rows.Next() {
		var status string
		var captured *time.Time
		if err := rows.Scan(&status, &captured); err != nil {
			return DerivedWindow{}, err
		}
		if captured == nil {
			continue
		}
		switch status {
		case "observed":
			observedDates = append(observedDates, *captured)
		case "missing":
			missingDates = append(missingDates, *captured)
		}
	}
	if err := rows.Err(); err != nil {
		return DerivedWindow{}, err
	}

	var win DerivedWindow

	// Precise dates seed both sides of their bound.
	if preciseStart != nil {
		win.StartedAtLower = ptr(*preciseStart)
		win.StartedAtUpper = ptr(*preciseStart)
	}
	if preciseEnd != nil {
		win.EndedAtLower = ptr(*preciseEnd)
		win.EndedAtUpper = ptr(*preciseEnd)
	}

	// Each observed date pulls started_upper down and ended_lower up.
	for _, t := range observedDates {
		t := t
		win.StartedAtUpper = minPtr(win.StartedAtUpper, &t)
		win.EndedAtLower = maxPtr(win.EndedAtLower, &t)
	}

	// Disambiguate each missing observation against the observed set.
	for _, m := range missingDates {
		m := m
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

	return win, nil
}

func derivedWindowEqual(a, b DerivedWindow) bool {
	return a.Inconsistent == b.Inconsistent &&
		timePtrEqual(a.StartedAtLower, b.StartedAtLower) &&
		timePtrEqual(a.StartedAtUpper, b.StartedAtUpper) &&
		timePtrEqual(a.EndedAtLower, b.EndedAtLower) &&
		timePtrEqual(a.EndedAtUpper, b.EndedAtUpper)
}

func ptr[T any](v T) *T { return &v }

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
