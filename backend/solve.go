package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/bmander/panorama-builder/backend/solver"
)

// solve.go wires the solver package into HTTP. Three handlers, each
// serialized by Server.solveMu:
//
//   POST /api/solve/joint                  → bundle adjust everything
//   POST /api/solve/stations/{id}          → refine one station's photo poses
//   POST /api/solve/control-points/{id}    → refine one CP's est_lat/lng/alt
//
// The solver itself is pure (no DB / HTTP); these handlers handle the I/O:
// load the in-scope rows, build solver.Problem, write the resulting Changes
// back inside one transaction with optimistic-concurrency checks against
// updated_at to surface concurrent edits as 409.

func (s *Server) postSolveJoint(w http.ResponseWriter, r *http.Request) {
	cfg, dryRun, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeJoint
	s.runSolve(w, r, cfg, dryRun)
}

func (s *Server) postSolveStation(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	cfg, dryRun, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeSingleStation
	cfg.FocusID = id
	s.runSolve(w, r, cfg, dryRun)
}

func (s *Server) postSolveControlPoint(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	cfg, dryRun, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeSingleControlPoint
	cfg.FocusID = id
	s.runSolve(w, r, cfg, dryRun)
}

func parseSolveConfig(w http.ResponseWriter, r *http.Request) (solver.Config, bool, bool) {
	cfg := solver.Config{}
	dryRun := false
	if r.ContentLength == 0 {
		return cfg, dryRun, true
	}
	var req SolveConfig
	if !parseJSON(w, r, &req) {
		return cfg, dryRun, false
	}
	if req.MaxIters != nil {
		cfg.MaxIters = *req.MaxIters
	}
	if req.ResidualTolRad != nil {
		cfg.ResidualTolRad = *req.ResidualTolRad
	}
	if req.RelImproveTol != nil {
		cfg.RelImproveTol = *req.RelImproveTol
	}
	if req.DryRun != nil {
		dryRun = *req.DryRun
	}
	return cfg, dryRun, true
}

func (s *Server) runSolve(w http.ResponseWriter, r *http.Request, cfg solver.Config, dryRun bool) {
	s.solveMu.Lock()
	defer s.solveMu.Unlock()

	ctx := r.Context()
	prob, exists, err := s.loadProblem(ctx, cfg)
	if err != nil {
		log.Printf("solver load: %v", err)
		writeError(w, http.StatusInternalServerError, "load failed")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "focus entity not found")
		return
	}

	res, err := solver.Solve(prob, cfg)
	if err != nil {
		switch {
		case errors.Is(err, solver.ErrUnderconstrainedGauge):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, solver.ErrFocusNotFound):
			writeError(w, http.StatusNotFound, err.Error())
		case errors.Is(err, solver.ErrInsufficientObservations):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			log.Printf("solver: %v", err)
			writeError(w, http.StatusInternalServerError, "solver failed")
		}
		return
	}

	if !dryRun && !res.Diverged && len(res.Changes) > 0 {
		if err := s.writebackChanges(ctx, prob, res); err != nil {
			if errors.Is(err, errConcurrentEdit) {
				writeError(w, http.StatusConflict, "concurrent edit; refresh and retry")
				return
			}
			log.Printf("solver writeback: %v", err)
			writeError(w, http.StatusInternalServerError, "writeback failed")
			return
		}
	}

	writeJSON(w, http.StatusOK, toAPISolveResult(res))
}

// postSolveJointStream is the SSE counterpart to postSolveJoint. The client
// receives one event per Gauss-Newton iteration as it happens, then a final
// terminal event. Each event is one line of the form
//
//	data: {"kind":"iter","iter":N,"rms":R,"accepted":bool}\n\n
//	data: {"kind":"done","result":{...SolveResult JSON...}}\n\n
//	data: {"kind":"stopped","result":{...SolveResult JSON...}}\n\n
//	data: {"kind":"cancelled"}\n\n
//	data: {"kind":"error","message":"..."}\n\n
//
// done    — solver ran to completion (converged / diverged / iter cap).
//
//	Writeback happened iff !dry_run, !diverged, and there were changes.
//
// stopped — user clicked "stop here"; the best iterate was written back
//
//	(skipped only on dry_run / diverged / no-changes).
//
// cancelled — user aborted (closed connection); no writeback.
//
// Joint mode only — single-station / single-CP keep their synchronous endpoints.
func (s *Server) postSolveJointStream(w http.ResponseWriter, r *http.Request) {
	cfg, dryRun, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeJoint
	// Streaming default: keep iterating until convergence/divergence finds a
	// natural stop. The user can interrupt via Cancel / Stop here, so a hard
	// cap mainly guards against pathological non-converging configurations.
	if cfg.MaxIters == 0 {
		cfg.MaxIters = 1000
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	s.solveMu.Lock()
	defer s.solveMu.Unlock()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	sendEvent := func(payload any) {
		body, err := json.Marshal(payload)
		if err != nil {
			log.Printf("solve stream marshal: %v", err)
			return
		}
		fmt.Fprintf(w, "data: %s\n\n", body)
		flusher.Flush()
	}
	sendError := func(msg string) {
		sendEvent(map[string]string{"kind": "error", "message": msg})
	}

	ctx := r.Context()
	prob, err := s.loadJointProblem(ctx)
	if err != nil {
		log.Printf("solver load: %v", err)
		sendError("load failed")
		return
	}

	// Register a stop channel so /api/solve/joint/stop can fire it.
	stopCh := make(chan struct{}, 1)
	s.activeStopMu.Lock()
	s.activeStop = stopCh
	s.activeStopMu.Unlock()
	defer func() {
		s.activeStopMu.Lock()
		s.activeStop = nil
		s.activeStopMu.Unlock()
	}()

	stopRequested := false
	cfg.OnIteration = func(iter int, rms float64, accepted bool) {
		sendEvent(map[string]any{
			"kind": "iter", "iter": iter, "rms": rms, "accepted": accepted,
		})
	}
	cfg.ShouldStop = func() bool {
		select {
		case <-ctx.Done():
			return true
		case <-stopCh:
			stopRequested = true
			return true
		default:
			return false
		}
	}

	res, err := solver.Solve(prob, cfg)
	if err != nil {
		sendError(err.Error())
		return
	}

	if ctx.Err() != nil {
		// Client aborted — stream is already torn down on the wire, but try
		// to write a terminal event for any reader still listening.
		sendEvent(map[string]string{"kind": "cancelled"})
		return
	}

	if !dryRun && !res.Diverged && len(res.Changes) > 0 {
		if err := s.writebackChanges(ctx, prob, res); err != nil {
			if errors.Is(err, errConcurrentEdit) {
				sendError("concurrent edit; refresh and retry")
				return
			}
			log.Printf("solver writeback: %v", err)
			sendError("writeback failed")
			return
		}
	}

	terminalKind := "done"
	if stopRequested {
		terminalKind = "stopped"
	}
	sendEvent(map[string]any{"kind": terminalKind, "result": toAPISolveResult(res)})
}

// postSolveJointStop signals an in-flight streaming solve to stop gracefully.
// The solver returns the best iterate so far; the streaming handler writes it
// back as if the loop had converged naturally and emits a "stopped" event.
func (s *Server) postSolveJointStop(w http.ResponseWriter, r *http.Request) {
	s.activeStopMu.Lock()
	ch := s.activeStop
	s.activeStopMu.Unlock()
	if ch == nil {
		writeError(w, http.StatusNotFound, "no active solve")
		return
	}
	select {
	case ch <- struct{}{}:
	default:
		// Already signaled; idempotent.
	}
	w.WriteHeader(http.StatusNoContent)
}

func toAPISolveResult(r solver.Result) SolveResult {
	out := SolveResult{
		Iterations:         r.Iterations,
		InitialResidualRms: r.InitialResidualRMS,
		FinalResidualRms:   r.FinalResidualRMS,
		Converged:          r.Converged,
		Diverged:           r.Diverged,
	}
	if len(r.AutoLockedColumns) > 0 {
		cols := append([]string(nil), r.AutoLockedColumns...)
		out.AutoLockedColumns = &cols
	}
	out.Changes = make([]EntityChange, 0, len(r.Changes))
	for _, c := range r.Changes {
		out.Changes = append(out.Changes, EntityChange{
			Kind:   EntityChangeKind(c.Kind),
			ID:     c.ID,
			Before: c.Before,
			After:  c.After,
		})
	}
	return out
}

// updatedAtSnapshot maps each entity ID to the updated_at value seen at load
// time. The writeback uses these as optimistic-concurrency tokens — an UPDATE
// with WHERE updated_at = $snapshot only succeeds if the row hasn't moved.
type updatedAtSnapshot struct {
	stations map[string]time.Time
	photos   map[string]time.Time
	cps      map[string]time.Time
}

// loadProblem reads everything in scope. Returns exists=false when the focus
// entity (single-station / single-CP) is missing.
func (s *Server) loadProblem(ctx context.Context, cfg solver.Config) (solver.Problem, bool, error) {
	switch cfg.Mode {
	case solver.ModeJoint:
		p, err := s.loadJointProblem(ctx)
		return p, true, err
	case solver.ModeSingleStation:
		p, ok, err := s.loadSingleStationProblem(ctx, cfg.FocusID)
		return p, ok, err
	case solver.ModeSingleControlPoint:
		p, ok, err := s.loadSingleCPProblem(ctx, cfg.FocusID)
		return p, ok, err
	}
	return solver.Problem{}, false, fmt.Errorf("unknown solve mode")
}

func (s *Server) loadJointProblem(ctx context.Context) (solver.Problem, error) {
	stations, err := loadAllStations(ctx, s.db)
	if err != nil {
		return solver.Problem{}, err
	}
	photos, err := loadAllPhotos(ctx, s.db)
	if err != nil {
		return solver.Problem{}, err
	}
	cps, nullLoc, err := loadAllControlPoints(ctx, s.db)
	if err != nil {
		return solver.Problem{}, err
	}
	obs, err := loadAllObservations(ctx, s.db)
	if err != nil {
		return solver.Problem{}, err
	}
	cps, obs = seedNullLocationCPs(cps, nullLoc, obs, photos, stations)
	return solver.Problem{Stations: stations, Photos: photos, ControlPoints: cps, Observations: obs}, nil
}

// meanStationLatLng returns the unweighted mean of the given stations'
// lat/lng. ok=false when stations is empty (caller decides what to do).
func meanStationLatLng(stations []solver.Station) (lat, lng float64, ok bool) {
	if len(stations) == 0 {
		return 0, 0, false
	}
	for _, st := range stations {
		lat += st.Lat
		lng += st.Lng
	}
	n := float64(len(stations))
	return lat / n, lng / n, true
}

// seedNullLocationCPs gives null-location CPs an initial position so the
// joint solver can refine them as free parameters; CPs with fewer than 2
// distinct contributing stations are dropped — a single ray can't constrain
// a 3D position. Observations referencing dropped CPs are removed too,
// otherwise the solver's CP-index lookup would silently point at the wrong
// row.
func seedNullLocationCPs(
	cps []solver.ControlPoint, nullLoc map[string]bool,
	obs []solver.Observation,
	photos []solver.Photo, stations []solver.Station,
) ([]solver.ControlPoint, []solver.Observation) {
	if len(nullLoc) == 0 {
		return cps, obs
	}

	photoStation := make(map[string]string, len(photos))
	for _, p := range photos {
		photoStation[p.ID] = p.StationID
	}
	stationByID := make(map[string]solver.Station, len(stations))
	for _, st := range stations {
		stationByID[st.ID] = st
	}

	cpStations := make(map[string]map[string]bool, len(nullLoc))
	for _, o := range obs {
		if !nullLoc[o.ControlPointID] {
			continue
		}
		if stID := photoStation[o.PhotoID]; stID != "" {
			set := cpStations[o.ControlPointID]
			if set == nil {
				set = map[string]bool{}
				cpStations[o.ControlPointID] = set
			}
			set[stID] = true
		}
	}

	drop := map[string]bool{}
	seedLat := map[string]float64{}
	seedLng := map[string]float64{}
	for cpID := range nullLoc {
		stIDs := cpStations[cpID]
		if len(stIDs) < 2 {
			drop[cpID] = true
			continue
		}
		contributing := make([]solver.Station, 0, len(stIDs))
		for stID := range stIDs {
			if st, ok := stationByID[stID]; ok {
				contributing = append(contributing, st)
			}
		}
		lat, lng, ok := meanStationLatLng(contributing)
		if !ok || len(contributing) < 2 {
			drop[cpID] = true
			continue
		}
		seedLat[cpID] = lat
		seedLng[cpID] = lng
	}

	keptCPs := make([]solver.ControlPoint, 0, len(cps))
	for _, cp := range cps {
		if drop[cp.ID] {
			continue
		}
		if nullLoc[cp.ID] {
			cp.EstLat = seedLat[cp.ID]
			cp.EstLng = seedLng[cp.ID]
		}
		keptCPs = append(keptCPs, cp)
	}

	keptObs := make([]solver.Observation, 0, len(obs))
	for _, o := range obs {
		if drop[o.ControlPointID] {
			continue
		}
		keptObs = append(keptObs, o)
	}

	return keptCPs, keptObs
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
	// est_alt is NOT NULL post-migration-0009; default-zero is fine as an alt seed.
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
	lock_photo_az, lock_photo_tilt, lock_photo_roll, lock_size_rad, updated_at`

func scanSolverPhoto(row pgx.Row) (solver.Photo, error) {
	var p solver.Photo
	err := row.Scan(&p.ID, &p.StationID, &p.Pose.Aspect, &p.Pose.PhotoAz, &p.Pose.PhotoTilt,
		&p.Pose.PhotoRoll, &p.Pose.SizeRad,
		&p.Locks.PhotoAz, &p.Locks.PhotoTilt, &p.Locks.PhotoRoll, &p.Locks.SizeRad,
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
// or solved directly; callers filter accordingly. est_alt is NOT NULL since
// migration 0009 (defaults to 0).
func scanSolverControlPoint(row pgx.Row) (solver.ControlPoint, error) {
	var cp solver.ControlPoint
	var lat, lng *float64
	err := row.Scan(&cp.ID, &lat, &lng, &cp.EstAlt,
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
		var lat, lng *float64
		if err := rows.Scan(&cp.ID, &lat, &lng, &cp.EstAlt,
			&cp.Locks.EstLat, &cp.Locks.EstLng, &cp.Locks.EstAlt, &cp.UpdatedAt); err != nil {
			return nil, nil, err
		}
		if lat == nil || lng == nil {
			nullLoc[cp.ID] = true
		} else {
			cp.EstLat = *lat
			cp.EstLng = *lng
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

// --- Writeback ---

var errConcurrentEdit = errors.New("concurrent edit detected")

// writebackChanges applies res.Changes inside one tx. Each UPDATE includes
// `WHERE id=$1 AND updated_at=$2` using the snapshot from problem-build —
// zero rows updated means another writer raced us.
func (s *Server) writebackChanges(ctx context.Context, prob solver.Problem, res solver.Result) error {
	stationsBy := map[string]time.Time{}
	for _, st := range prob.Stations {
		stationsBy[st.ID] = st.UpdatedAt
	}
	photosBy := map[string]time.Time{}
	for _, p := range prob.Photos {
		photosBy[p.ID] = p.UpdatedAt
	}
	cpsBy := map[string]time.Time{}
	for _, cp := range prob.ControlPoints {
		cpsBy[cp.ID] = cp.UpdatedAt
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, c := range res.Changes {
		switch c.Kind {
		case "station":
			updated, err := updateStationFromChange(ctx, tx, c, stationsBy[c.ID])
			if err != nil {
				return err
			}
			if !updated {
				return errConcurrentEdit
			}
		case "photo":
			updated, err := updatePhotoFromChange(ctx, tx, c, photosBy[c.ID])
			if err != nil {
				return err
			}
			if !updated {
				return errConcurrentEdit
			}
		case "control_point":
			updated, err := updateCPFromChange(ctx, tx, c, cpsBy[c.ID])
			if err != nil {
				return err
			}
			if !updated {
				return errConcurrentEdit
			}
		default:
			return fmt.Errorf("unknown change kind %q", c.Kind)
		}
	}
	return tx.Commit(ctx)
}

func updateStationFromChange(ctx context.Context, tx pgx.Tx, c solver.EntityChange, snapshot time.Time) (bool, error) {
	// Update only the fields the change touched — partial UPDATE per row.
	args := []any{c.ID, snapshot}
	sets := ""
	idx := 3
	for k, v := range c.After {
		if sets != "" {
			sets += ", "
		}
		switch k {
		case "lat":
			sets += fmt.Sprintf("lat = $%d", idx)
		case "lng":
			sets += fmt.Sprintf("lng = $%d", idx)
		case "alt":
			sets += fmt.Sprintf("alt = $%d", idx)
		default:
			return false, fmt.Errorf("station change: unknown key %q", k)
		}
		args = append(args, v)
		idx++
	}
	if sets == "" {
		return true, nil
	}
	tag, err := tx.Exec(ctx,
		fmt.Sprintf(`UPDATE stations SET %s, updated_at = NOW() WHERE id = $1 AND updated_at = $2`, sets),
		args...)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func updatePhotoFromChange(ctx context.Context, tx pgx.Tx, c solver.EntityChange, snapshot time.Time) (bool, error) {
	args := []any{c.ID, snapshot}
	sets := ""
	idx := 3
	for k, v := range c.After {
		if sets != "" {
			sets += ", "
		}
		switch k {
		case "photo_az", "photo_tilt", "photo_roll", "size_rad":
			sets += fmt.Sprintf("%s = $%d", k, idx)
		default:
			return false, fmt.Errorf("photo change: unknown key %q", k)
		}
		args = append(args, v)
		idx++
	}
	if sets == "" {
		return true, nil
	}
	tag, err := tx.Exec(ctx,
		fmt.Sprintf(`UPDATE photos SET %s, updated_at = NOW() WHERE id = $1 AND updated_at = $2`, sets),
		args...)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func updateCPFromChange(ctx context.Context, tx pgx.Tx, c solver.EntityChange, snapshot time.Time) (bool, error) {
	args := []any{c.ID, snapshot}
	sets := ""
	idx := 3
	for k, v := range c.After {
		if sets != "" {
			sets += ", "
		}
		switch k {
		case "est_lat", "est_lng", "est_alt":
			sets += fmt.Sprintf("%s = $%d", k, idx)
		default:
			return false, fmt.Errorf("cp change: unknown key %q", k)
		}
		args = append(args, v)
		idx++
	}
	if sets == "" {
		return true, nil
	}
	tag, err := tx.Exec(ctx,
		fmt.Sprintf(`UPDATE control_points SET %s, updated_at = NOW() WHERE id = $1 AND updated_at = $2`, sets),
		args...)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
