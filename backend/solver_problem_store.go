package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/bmander/panorama-builder/backend/solver"
)

// loadProblem reads everything in scope. Returns exists=false when the focus
// entity (single-station / single-CP) is missing. seededCPIDs is non-empty
// only for ModeJoint and lists the CPs that came from the DB with NULL
// est_lat/est_lng and survived the ≥2-station seeding filter; the joint
// orchestrator runs a per-CP refinement on each before the joint solve.
func (s *Server) loadProblem(ctx context.Context, cfg solver.Config) (solver.Problem, []string, bool, error) {
	switch cfg.Mode {
	case solver.ModeJoint:
		p, seeded, err := s.loadJointProblem(ctx)
		return p, seeded, true, err
	case solver.ModeSingleStation:
		p, ok, err := s.loadSingleStationProblem(ctx, cfg.FocusID)
		return p, nil, ok, err
	case solver.ModeSingleControlPoint:
		p, ok, err := s.loadSingleCPProblem(ctx, cfg.FocusID)
		return p, nil, ok, err
	}
	return solver.Problem{}, nil, false, fmt.Errorf("unknown solve mode")
}

func (s *Server) loadJointProblem(ctx context.Context) (solver.Problem, []string, error) {
	stations, err := loadAllStations(ctx, s.db)
	if err != nil {
		return solver.Problem{}, nil, err
	}
	photos, err := loadAllPhotos(ctx, s.db)
	if err != nil {
		return solver.Problem{}, nil, err
	}
	cps, nullLoc, err := loadAllControlPoints(ctx, s.db)
	if err != nil {
		return solver.Problem{}, nil, err
	}
	obs, err := loadAllObservations(ctx, s.db)
	if err != nil {
		return solver.Problem{}, nil, err
	}
	cps, obs, seeded := seedNullLocationCPs(cps, nullLoc, obs, photos, stations)
	return solver.Problem{Stations: stations, Photos: photos, ControlPoints: cps, Observations: obs}, seeded, nil
}

func (s *Server) loadSingleStationProblem(ctx context.Context, stationID string) (solver.Problem, bool, error) {
	st, err := loadOneStation(ctx, s.db, stationID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return solver.Problem{}, false, nil
		}
		return solver.Problem{}, false, err
	}
	photos, err := loadPhotosByStation(ctx, s.db, stationID)
	if err != nil {
		return solver.Problem{}, false, err
	}
	obs, err := loadObservationsForPhotos(ctx, s.db, photoIDs(photos))
	if err != nil {
		return solver.Problem{}, false, err
	}
	cps, err := loadCPsByIDs(ctx, s.db, cpIDsFromObs(obs))
	if err != nil {
		return solver.Problem{}, false, err
	}
	return solver.Problem{Stations: []solver.Station{st}, Photos: photos, ControlPoints: cps, Observations: obs}, true, nil
}

func (s *Server) loadSingleCPProblem(ctx context.Context, cpID string) (solver.Problem, bool, error) {
	cp, err := loadOneControlPoint(ctx, s.db, cpID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return solver.Problem{}, false, nil
		}
		return solver.Problem{}, false, err
	}
	obs, err := loadObservationsForCP(ctx, s.db, cpID)
	if err != nil {
		return solver.Problem{}, false, err
	}
	photos, err := loadPhotosByIDs(ctx, s.db, photoIDsFromObs(obs))
	if err != nil {
		return solver.Problem{}, false, err
	}
	stations, err := loadStationsByIDs(ctx, s.db, stationIDsFromPhotos(photos))
	if err != nil {
		return solver.Problem{}, false, err
	}
	// Seed est_lat/lng if NULL with the mean of the contributing stations.
	// NULL est_alt is already seeded to 0 in scanSolverControlPoint, so the
	// solver always has a 3D guess to start from.
	if cp.EstLat == 0 && cp.EstLng == 0 {
		if lat, lng, ok := meanStationLatLng(stations); ok {
			cp.EstLat = lat
			cp.EstLng = lng
		}
	}
	return solver.Problem{Stations: stations, Photos: photos, ControlPoints: []solver.ControlPoint{cp}, Observations: obs}, true, nil
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

func loadOneStation(ctx context.Context, db *pgxpool.Pool, id string) (solver.Station, error) {
	return scanSolverStation(db.QueryRow(ctx,
		`SELECT `+stationLoadCols+` FROM stations WHERE id = $1`, id))
}

func loadStationsByIDs(ctx context.Context, db *pgxpool.Pool, ids []string) ([]solver.Station, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := db.Query(ctx, `SELECT `+stationLoadCols+` FROM stations WHERE id = ANY($1)`, ids)
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

func loadPhotosByStation(ctx context.Context, db *pgxpool.Pool, stationID string) ([]solver.Photo, error) {
	rows, err := db.Query(ctx, `SELECT `+photoLoadCols+` FROM photos WHERE station_id = $1`, stationID)
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

func loadPhotosByIDs(ctx context.Context, db *pgxpool.Pool, ids []string) ([]solver.Photo, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := db.Query(ctx, `SELECT `+photoLoadCols+` FROM photos WHERE id = ANY($1)`, ids)
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

func loadOneControlPoint(ctx context.Context, db *pgxpool.Pool, id string) (solver.ControlPoint, error) {
	return scanSolverControlPoint(db.QueryRow(ctx,
		`SELECT `+cpLoadCols+` FROM control_points WHERE id = $1`, id))
}

func loadCPsByIDs(ctx context.Context, db *pgxpool.Pool, ids []string) ([]solver.ControlPoint, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := db.Query(ctx,
		`SELECT `+cpLoadCols+` FROM control_points
		 WHERE id = ANY($1) AND est_lat IS NOT NULL AND est_lng IS NOT NULL`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []solver.ControlPoint
	for rows.Next() {
		cp, err := scanSolverControlPoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, cp)
	}
	return out, rows.Err()
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

func loadObservationsForPhotos(ctx context.Context, db *pgxpool.Pool, photoIDs []string) ([]solver.Observation, error) {
	if len(photoIDs) == 0 {
		return nil, nil
	}
	rows, err := db.Query(ctx,
		`SELECT id, photo_id, control_point_id, u, v
		 FROM image_measurements WHERE photo_id = ANY($1) AND control_point_id IS NOT NULL`, photoIDs)
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

func loadObservationsForCP(ctx context.Context, db *pgxpool.Pool, cpID string) ([]solver.Observation, error) {
	rows, err := db.Query(ctx,
		`SELECT id, photo_id, control_point_id, u, v
		 FROM image_measurements WHERE control_point_id = $1`, cpID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []solver.Observation
	for rows.Next() {
		var o solver.Observation
		var cp *string
		if err := rows.Scan(&o.ID, &o.PhotoID, &cp, &o.U, &o.V); err != nil {
			return nil, err
		}
		if cp != nil {
			o.ControlPointID = *cp
			out = append(out, o)
		}
	}
	return out, rows.Err()
}

func photoIDs(ps []solver.Photo) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.ID
	}
	return out
}

func photoIDsFromObs(obs []solver.Observation) []string {
	seen := map[string]bool{}
	var out []string
	for _, o := range obs {
		if !seen[o.PhotoID] {
			seen[o.PhotoID] = true
			out = append(out, o.PhotoID)
		}
	}
	return out
}

func cpIDsFromObs(obs []solver.Observation) []string {
	seen := map[string]bool{}
	var out []string
	for _, o := range obs {
		if !seen[o.ControlPointID] {
			seen[o.ControlPointID] = true
			out = append(out, o.ControlPointID)
		}
	}
	return out
}

func stationIDsFromPhotos(ps []solver.Photo) []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range ps {
		if !seen[p.StationID] {
			seen[p.StationID] = true
			out = append(out, p.StationID)
		}
	}
	return out
}
