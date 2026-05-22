//go:build !noceres

package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/bmander/panorama-builder/backend/solver"
)

// loadProblem reads everything in scope through the active session's overlay
// so in-session edits (including newly-created stations / CPs that haven't
// been merged) are visible to the solver. Returns exists=false when the
// focus entity is missing. seededCPIDs is non-empty only for ModeJoint and
// lists the CPs that came from the DB with NULL est_lat/est_lng and
// survived the ≥2-station seeding filter; the joint orchestrator runs a
// per-CP refinement on each before the joint solve.
func (s *Server) loadProblem(ctx context.Context, cfg solver.Config, sess *Session) (solver.Problem, []string, bool, error) {
	switch cfg.Mode {
	case solver.ModeJoint:
		p, seeded, err := s.loadJointProblemSession(ctx, sess)
		return p, seeded, true, err
	case solver.ModeSingleStation:
		p, ok, err := s.loadSingleStationProblemSession(ctx, sess, cfg.FocusID)
		return p, nil, ok, err
	case solver.ModeSingleControlPoint:
		p, ok, err := s.loadSingleCPProblemSession(ctx, sess, cfg.FocusID)
		return p, nil, ok, err
	}
	return solver.Problem{}, nil, false, fmt.Errorf("unknown solve mode")
}

// --- DB loaders. Each one fills in the solver-side type directly so the
// handlers don't have to translate. updated_at is preserved as the
// optimistic-concurrency token. ---

const stationLoadCols = `id, lat, lng, alt, lock_lat, lock_lng, lock_alt, updated_at`

func scanSolverStation(row pgx.Row) (solver.Station, error) {
	var s solver.Station
	err := row.Scan(&s.ID, &s.Lat, &s.Lng, &s.Alt,
		&s.Locks.Lat, &s.Locks.Lng, &s.Locks.Alt, &s.UpdatedAt)
	return s, err
}

func loadAllStations(ctx context.Context, db *pgxpool.Pool) ([]solver.Station, error) {
	rows, err := db.Query(ctx, `SELECT `+stationLoadCols+` FROM stations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []solver.Station
	for rows.Next() {
		s, err := scanSolverStation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

const photoLoadCols = `id, station_id, aspect, photo_az, photo_tilt, photo_roll, size_rad,
	lock_photo_az, lock_photo_tilt, lock_photo_roll, lock_size_rad,
	dist_k1, dist_k2, lock_dist_k1, lock_dist_k2, updated_at`

func scanSolverPhoto(row pgx.Row) (solver.Photo, error) {
	var p solver.Photo
	err := row.Scan(&p.ID, &p.StationID, &p.Pose.Aspect, &p.Pose.PhotoAz, &p.Pose.PhotoTilt,
		&p.Pose.PhotoRoll, &p.Pose.SizeRad,
		&p.Locks.PhotoAz, &p.Locks.PhotoTilt, &p.Locks.PhotoRoll, &p.Locks.SizeRad,
		&p.Pose.K1, &p.Pose.K2, &p.Locks.K1, &p.Locks.K2,
		&p.UpdatedAt)
	return p, err
}

func loadAllPhotos(ctx context.Context, db *pgxpool.Pool) ([]solver.Photo, error) {
	rows, err := db.Query(ctx, `SELECT `+photoLoadCols+` FROM photos`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []solver.Photo
	for rows.Next() {
		p, err := scanSolverPhoto(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

const cpLoadCols = `id, est_lat, est_lng, est_alt, lock_est_lat, lock_est_lng, lock_est_alt, updated_at`

// scanSolverControlPoint reads a CP row. NULL est_lat / est_lng make the row
// unsuitable for being either a participant in joint mode (no initial guess)
// or solved directly; callers filter accordingly. NULL est_alt is seeded to 0
// here so the solver always has a 3D guess; if the user hasn't locked
// est_alt, the solver will refine it from observations and writeback persists
// the new value.
func scanSolverControlPoint(row pgx.Row) (solver.ControlPoint, error) {
	var cp solver.ControlPoint
	var lat, lng, alt *float64
	err := row.Scan(&cp.ID, &lat, &lng, &alt,
		&cp.Locks.EstLat, &cp.Locks.EstLng, &cp.Locks.EstAlt, &cp.UpdatedAt)
	if err != nil {
		return cp, err
	}
	if lat != nil {
		cp.EstLat = *lat
	}
	if lng != nil {
		cp.EstLng = *lng
	}
	if alt != nil {
		cp.EstAlt = *alt
	}
	return cp, nil
}

// loadAllControlPoints returns every CP, plus the set of IDs whose est_lat
// or est_lng came back NULL. Joint mode seeds those before handing the
// problem to the solver (using the mean station location of the CP's
// observations) so the solver can triangulate them as free parameters.
func loadAllControlPoints(ctx context.Context, db *pgxpool.Pool) ([]solver.ControlPoint, map[string]bool, error) {
	rows, err := db.Query(ctx, `SELECT `+cpLoadCols+` FROM control_points`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var out []solver.ControlPoint
	nullLoc := map[string]bool{}
	for rows.Next() {
		var cp solver.ControlPoint
		var lat, lng, alt *float64
		if err := rows.Scan(&cp.ID, &lat, &lng, &alt,
			&cp.Locks.EstLat, &cp.Locks.EstLng, &cp.Locks.EstAlt, &cp.UpdatedAt); err != nil {
			return nil, nil, err
		}
		if lat == nil || lng == nil {
			nullLoc[cp.ID] = true
		} else {
			cp.EstLat = *lat
			cp.EstLng = *lng
		}
		if alt != nil {
			cp.EstAlt = *alt
		}
		out = append(out, cp)
	}
	return out, nullLoc, rows.Err()
}

func loadAllObservations(ctx context.Context, db *pgxpool.Pool) ([]solver.Observation, error) {
	rows, err := db.Query(ctx,
		`SELECT id, photo_id, control_point_id, u, v FROM image_measurements WHERE control_point_id IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []solver.Observation
	for rows.Next() {
		var o solver.Observation
		var cpID *string
		if err := rows.Scan(&o.ID, &o.PhotoID, &cpID, &o.U, &o.V); err != nil {
			return nil, err
		}
		if cpID != nil {
			o.ControlPointID = *cpID
			out = append(out, o)
		}
	}
	return out, rows.Err()
}

// idSet collects each element's id into a membership set. Used by the
// filter helpers in this package when an inner loop needs O(1) lookups
// against a slice of typed entities.
func idSet[T any](xs []T, id func(T) string) map[string]struct{} {
	out := make(map[string]struct{}, len(xs))
	for _, x := range xs {
		out[id(x)] = struct{}{}
	}
	return out
}

func filterSlice[T any](xs []T, keep func(T) bool) []T {
	out := make([]T, 0, len(xs))
	for _, x := range xs {
		if keep(x) {
			out = append(out, x)
		}
	}
	return out
}

func filterByIDSet[T any](xs []T, id func(T) string, ids map[string]struct{}) []T {
	return filterSlice(xs, func(x T) bool {
		_, ok := ids[id(x)]
		return ok
	})
}

// filterCPConstraintsByCPSet drops constraints whose endpoints aren't both
// in the given CP slice. Single-station and single-CP modes restrict the
// active CP set, so a half-loaded constraint has no anchor and would be
// silently ignored by the solver anyway.
func filterCPConstraintsByCPSet(cons []solver.CPConstraint, cps []solver.ControlPoint) []solver.CPConstraint {
	if len(cons) == 0 {
		return nil
	}
	in := idSet(cps, func(cp solver.ControlPoint) string { return cp.ID })
	out := cons[:0:0]
	for _, c := range cons {
		if _, ok := in[c.CpAID]; !ok {
			continue
		}
		if _, ok := in[c.CpBID]; !ok {
			continue
		}
		out = append(out, c)
	}
	return out
}
