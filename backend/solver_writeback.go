package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/bmander/panorama-builder/backend/solver"
)

var errConcurrentEdit = errors.New("concurrent edit detected")

// updateTargets maps each EntityChange.Kind to the table it writes and the
// columns the solver is allowed to touch. Anything not in `cols` is a
// programmer error in the solver and surfaces as a 500.
var updateTargets = map[string]struct {
	table string
	cols  map[string]bool
}{
	"station":       {"stations", map[string]bool{"lat": true, "lng": true, "alt": true}},
	"photo":         {"photos", map[string]bool{"photo_az": true, "photo_tilt": true, "photo_roll": true, "size_rad": true}},
	"control_point": {"control_points", map[string]bool{"est_lat": true, "est_lng": true, "est_alt": true}},
}

// writebackChanges applies res.Changes inside one tx. Each UPDATE includes
// `WHERE id=$1 AND updated_at=$2` using the snapshot from problem-build —
// zero rows updated means another writer raced us.
func (s *Server) writebackChanges(ctx context.Context, prob solver.Problem, res solver.Result) error {
	snapshots := map[string]map[string]time.Time{
		"station":       {},
		"photo":         {},
		"control_point": {},
	}
	for _, st := range prob.Stations {
		snapshots["station"][st.ID] = st.UpdatedAt
	}
	for _, p := range prob.Photos {
		snapshots["photo"][p.ID] = p.UpdatedAt
	}
	for _, cp := range prob.ControlPoints {
		snapshots["control_point"][cp.ID] = cp.UpdatedAt
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, c := range res.Changes {
		target, ok := updateTargets[c.Kind]
		if !ok {
			return fmt.Errorf("unknown change kind %q", c.Kind)
		}
		updated, err := updateFromChange(ctx, tx, target.table, c.Kind, target.cols, c, snapshots[c.Kind][c.ID])
		if err != nil {
			return err
		}
		if !updated {
			return errConcurrentEdit
		}
	}
	return tx.Commit(ctx)
}

// updateFromChange runs a partial UPDATE over only the columns the change
// touched, gated by the optimistic-concurrency snapshot. Returns false when
// zero rows matched (the row moved between load and writeback).
func updateFromChange(ctx context.Context, tx pgx.Tx, table, kind string, allowed map[string]bool, c solver.EntityChange, snapshot time.Time) (bool, error) {
	args := []any{c.ID, snapshot}
	sets := ""
	idx := 3
	for k, v := range c.After {
		if !allowed[k] {
			return false, fmt.Errorf("%s change: unknown key %q", kind, k)
		}
		if sets != "" {
			sets += ", "
		}
		sets += fmt.Sprintf("%s = $%d", k, idx)
		args = append(args, v)
		idx++
	}
	if sets == "" {
		return true, nil
	}
	tag, err := tx.Exec(ctx,
		fmt.Sprintf(`UPDATE %s SET %s, updated_at = NOW() WHERE id = $1 AND updated_at = $2`, table, sets),
		args...)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
