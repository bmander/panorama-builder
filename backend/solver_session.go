package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/bmander/panorama-builder/shared/wire"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// loadSingleStationProblemSession restricts the overlaid joint set to one
// station and the photos / observations / CPs that anchor to it. ok=false
// means the focus station isn't in the (overlaid) station set.
func (s *Server) loadSingleStationProblemSession(ctx context.Context, sess *Session, stationID string) (wire.Problem, bool, error) {
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		return wire.Problem{}, false, err
	}
	stations, err := s.loadAllSolverStationsOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, false, err
	}
	i := slices.IndexFunc(stations, func(st wire.Station) bool { return st.ID == stationID })
	if i < 0 {
		return wire.Problem{}, false, nil
	}
	station := stations[i]
	allPhotos, err := s.loadAllSolverPhotosOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, false, err
	}
	photos := filterSlice(allPhotos, func(p wire.Photo) bool { return p.StationID == stationID })
	allObs, err := s.loadAllSolverObservationsOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, false, err
	}
	photoIDSet := idSet(photos, func(p wire.Photo) string { return p.ID })
	var obs []wire.Observation
	cpIDSet := map[string]struct{}{}
	for _, o := range allObs {
		if _, ok := photoIDSet[o.PhotoID]; !ok {
			continue
		}
		obs = append(obs, o)
		cpIDSet[o.ControlPointID] = struct{}{}
	}
	allCPs, _, err := s.loadAllSolverCPsOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, false, err
	}
	cps := filterByIDSet(allCPs, func(cp wire.ControlPoint) string { return cp.ID }, cpIDSet)
	cons, err := s.loadProblemCPConstraintsOverlaid(ctx, overlay, cps)
	if err != nil {
		return wire.Problem{}, false, err
	}
	return wire.Problem{
		Stations: []wire.Station{station}, Photos: photos,
		ControlPoints: cps, Observations: obs,
		CPConstraints: cons,
	}, true, nil
}

// loadSingleCPProblemSession restricts the overlaid joint set to one CP and
// the photos / stations that observe it, seeding a NULL-location CP from
// the mean of its contributing stations.
func (s *Server) loadSingleCPProblemSession(ctx context.Context, sess *Session, cpID string) (wire.Problem, bool, error) {
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		return wire.Problem{}, false, err
	}
	allCPs, _, err := s.loadAllSolverCPsOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, false, err
	}
	i := slices.IndexFunc(allCPs, func(c wire.ControlPoint) bool { return c.ID == cpID })
	if i < 0 {
		return wire.Problem{}, false, nil
	}
	cp := allCPs[i]
	allObs, err := s.loadAllSolverObservationsOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, false, err
	}
	var obs []wire.Observation
	photoIDSet := map[string]struct{}{}
	for _, o := range allObs {
		if o.ControlPointID != cpID {
			continue
		}
		obs = append(obs, o)
		photoIDSet[o.PhotoID] = struct{}{}
	}
	allPhotos, err := s.loadAllSolverPhotosOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, false, err
	}
	var photos []wire.Photo
	stationIDSet := map[string]struct{}{}
	for _, p := range allPhotos {
		if _, ok := photoIDSet[p.ID]; !ok {
			continue
		}
		photos = append(photos, p)
		stationIDSet[p.StationID] = struct{}{}
	}
	allStations, err := s.loadAllSolverStationsOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, false, err
	}
	stations := filterByIDSet(allStations, func(st wire.Station) string { return st.ID }, stationIDSet)
	if cp.EstLat == 0 && cp.EstLng == 0 {
		if lat, lng, ok := meanStationLatLng(stations); ok {
			cp.EstLat = lat
			cp.EstLng = lng
		}
	}
	cps := []wire.ControlPoint{cp}
	cons, err := s.loadProblemCPConstraintsOverlaid(ctx, overlay, cps)
	if err != nil {
		return wire.Problem{}, false, err
	}
	return wire.Problem{
		Stations: stations, Photos: photos,
		ControlPoints: cps, Observations: obs,
		CPConstraints: cons,
	}, true, nil
}

func (s *Server) loadJointProblemSession(ctx context.Context, sess *Session) (wire.Problem, []string, error) {
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		return wire.Problem{}, nil, err
	}
	stations, err := s.loadAllSolverStationsOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, nil, err
	}
	photos, err := s.loadAllSolverPhotosOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, nil, err
	}
	cps, nullLoc, err := s.loadAllSolverCPsOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, nil, err
	}
	obs, err := s.loadAllSolverObservationsOverlaid(ctx, overlay)
	if err != nil {
		return wire.Problem{}, nil, err
	}
	obs = filterOrphanObservations(obs, cps, photos)
	cps, obs, seeded := seedNullLocationCPs(cps, nullLoc, obs, photos, stations)
	cons, err := s.loadProblemCPConstraintsOverlaid(ctx, overlay, cps)
	if err != nil {
		return wire.Problem{}, nil, err
	}
	return wire.Problem{
		Stations: stations, Photos: photos,
		ControlPoints: cps, Observations: obs,
		CPConstraints: cons,
	}, seeded, nil
}

// filterOrphanObservations drops observations whose photo or CP isn't in
// the overlaid problem. Without it, a session-only delete (journaled but
// not yet cascaded into main) leaves dangling obs and the solver's
// cpIdx/photoIdx miss silently resolves to entity 0.
func filterOrphanObservations(obs []wire.Observation, cps []wire.ControlPoint, photos []wire.Photo) []wire.Observation {
	cpIDs := idSet(cps, func(cp wire.ControlPoint) string { return cp.ID })
	photoIDs := idSet(photos, func(p wire.Photo) string { return p.ID })
	out := make([]wire.Observation, 0, len(obs))
	for _, o := range obs {
		if _, ok := cpIDs[o.ControlPointID]; !ok {
			continue
		}
		if _, ok := photoIDs[o.PhotoID]; !ok {
			continue
		}
		out = append(out, o)
	}
	return out
}

// The loadAllSolverXOverlaid helpers use mergeOverlay: the decode function
// converts the API-shaped row stored in the journal into the trimmed
// solver-shape type the bundle adjuster expects.

func (s *Server) loadAllSolverStationsOverlaid(ctx context.Context, overlay sessionOverlay) ([]wire.Station, error) {
	base, err := loadAllStations(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityStation],
		func(st wire.Station) string { return st.ID },
		decodeSolverStation,
		func(wire.Station) bool { return true })
}

func decodeSolverStation(b []byte) (wire.Station, error) {
	var st Station
	if err := json.Unmarshal(b, &st); err != nil {
		return wire.Station{}, err
	}
	return wire.Station{
		ID: st.ID, Lat: st.Lat, Lng: st.Lng, Alt: st.Alt,
		Locks:     wire.StationLocks{Lat: st.LockLat, Lng: st.LockLng, Alt: st.LockAlt},
		UpdatedAt: st.UpdatedAt,
	}, nil
}

func (s *Server) loadAllSolverPhotosOverlaid(ctx context.Context, overlay sessionOverlay) ([]wire.Photo, error) {
	base, err := loadAllPhotos(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityPhoto],
		func(p wire.Photo) string { return p.ID },
		decodeSolverPhoto,
		func(wire.Photo) bool { return true })
}

func decodeSolverPhoto(b []byte) (wire.Photo, error) {
	var p Photo
	if err := json.Unmarshal(b, &p); err != nil {
		return wire.Photo{}, err
	}
	return wire.Photo{
		ID: p.ID, StationID: p.StationID,
		Pose: wire.Pose{
			Aspect: p.Aspect, PhotoAz: p.PhotoAz, PhotoTilt: p.PhotoTilt,
			PhotoRoll: p.PhotoRoll, SizeRad: p.SizeRad,
			K1: p.DistK1, K2: p.DistK2,
		},
		Locks: wire.PhotoLocks{
			PhotoAz: p.LockPhotoAz, PhotoTilt: p.LockPhotoTilt,
			PhotoRoll: p.LockPhotoRoll, SizeRad: p.LockSizeRad,
			K1: p.LockDistK1, K2: p.LockDistK2,
		},
		UpdatedAt: p.UpdatedAt,
	}, nil
}

// CPs are special: the solver needs to know which ones have null lat/lng so
// it can seed them from station means. We merge, then walk the result once
// to rebuild the nullLoc map (the overlay may have nulled out a previously-
// estimated CP, or vice versa).
func (s *Server) loadAllSolverCPsOverlaid(ctx context.Context, overlay sessionOverlay) ([]wire.ControlPoint, map[string]bool, error) {
	base, baseNull, err := loadAllControlPoints(ctx, s.db)
	if err != nil {
		return nil, nil, err
	}
	merged, err := mergeOverlay(base, overlay[entityControlPoint],
		func(cp wire.ControlPoint) string { return cp.ID },
		decodeSolverCP,
		func(wire.ControlPoint) bool { return true })
	if err != nil {
		return nil, nil, err
	}
	nullLoc := map[string]bool{}
	bucket := overlay[entityControlPoint]
	for _, cp := range merged {
		// A row is null-located when it's in baseNull AND wasn't overlaid, OR
		// it was overlaid and the overlaid copy has no lat/lng.
		if _, touched := bucket[cp.ID]; touched {
			if cp.EstLat == 0 && cp.EstLng == 0 {
				nullLoc[cp.ID] = true
			}
		} else if baseNull[cp.ID] {
			nullLoc[cp.ID] = true
		}
	}
	return merged, nullLoc, nil
}

func decodeSolverCP(b []byte) (wire.ControlPoint, error) {
	var cp ControlPoint
	if err := json.Unmarshal(b, &cp); err != nil {
		return wire.ControlPoint{}, err
	}
	out := wire.ControlPoint{
		ID:        cp.ID,
		Locks:     wire.CPLocks{EstLat: cp.LockEstLat, EstLng: cp.LockEstLng, EstAlt: cp.LockEstAlt},
		UpdatedAt: cp.UpdatedAt,
	}
	if cp.EstLat != nil {
		out.EstLat = *cp.EstLat
	}
	if cp.EstLng != nil {
		out.EstLng = *cp.EstLng
	}
	if cp.EstAlt != nil {
		out.EstAlt = *cp.EstAlt
	}
	return out, nil
}

func (s *Server) loadAllSolverObservationsOverlaid(ctx context.Context, overlay sessionOverlay) ([]wire.Observation, error) {
	base, err := loadAllObservations(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityImageMeasurement],
		func(o wire.Observation) string { return o.ID },
		decodeSolverObservation,
		// Drop measurements with no CP link: the solver only consumes
		// observations that anchor to a control point.
		func(o wire.Observation) bool { return o.ControlPointID != "" })
}

func decodeSolverObservation(b []byte) (wire.Observation, error) {
	var im ImageMeasurement
	if err := json.Unmarshal(b, &im); err != nil {
		return wire.Observation{}, err
	}
	out := wire.Observation{ID: im.ID, PhotoID: im.PhotoID, U: im.U, V: im.V}
	if im.ControlPointID != nil {
		out.ControlPointID = *im.ControlPointID
	}
	return out, nil
}

// loadProblemCPConstraintsOverlaid: the wire.CPConstraint type drops the
// id (the solver doesn't need it), so we wrap ids alongside for the
// overlay lookup and unwrap on the way out.
func (s *Server) loadProblemCPConstraintsOverlaid(ctx context.Context, overlay sessionOverlay, cps []wire.ControlPoint) ([]wire.CPConstraint, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, cp_a_id, cp_b_id, constraint_type FROM cp_constraints`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type idConstraint struct {
		ID string
		C  wire.CPConstraint
	}
	var base []idConstraint
	for rows.Next() {
		var ic idConstraint
		if err := rows.Scan(&ic.ID, &ic.C.CpAID, &ic.C.CpBID, &ic.C.ConstraintType); err != nil {
			return nil, err
		}
		base = append(base, ic)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	merged, err := mergeOverlay(base, overlay[entityCPConstraint],
		func(ic idConstraint) string { return ic.ID },
		func(b []byte) (idConstraint, error) {
			var c CPConstraint
			if err := json.Unmarshal(b, &c); err != nil {
				return idConstraint{}, err
			}
			return idConstraint{ID: c.ID, C: wire.CPConstraint{
				CpAID: c.CpAId, CpBID: c.CpBId, ConstraintType: string(c.ConstraintType),
			}}, nil
		},
		func(idConstraint) bool { return true })
	if err != nil {
		return nil, err
	}
	out := make([]wire.CPConstraint, len(merged))
	for i, ic := range merged {
		out[i] = ic.C
	}
	return filterCPConstraintsByCPSet(out, cps), nil
}

// solveUndoOp / solveUndoSnapshot serialize a session's journal as it stood
// just before a solver writeback. Persisted in sessions.solve_undo_json so the
// most recent solve can be undone within the still-open session. before_json /
// after_json are carried verbatim as raw JSON (nil for the populated-on-one-
// side insert/delete shapes).
type solveUndoOp struct {
	Seq        int64           `json:"seq"`
	EntityType string          `json:"entity_type"`
	EntityID   string          `json:"entity_id"`
	Op         string          `json:"op"`
	BeforeJSON json.RawMessage `json:"before_json,omitempty"`
	AfterJSON  json.RawMessage `json:"after_json,omitempty"`
}

type solveUndoSnapshot struct {
	Ops          []solveUndoOp `json:"ops"`
	NextSeq      int64         `json:"next_seq"`
	LastSolveRMS *float64      `json:"last_solve_rms,omitempty"`
}

// captureSolveUndoSnapshot records the session's pre-writeback journal into
// sessions.solve_undo_json. Must run inside the writeback tx, before recordOp
// mutates session_ops / next_seq, so the snapshot reflects the true pre-solve
// state. last_solve_rms is still the prior run's value here (recordSolveRMS
// runs after writeback), which is exactly what undo should restore.
func captureSolveUndoSnapshot(ctx context.Context, tx pgx.Tx, sessionID string) error {
	var snap solveUndoSnapshot
	if err := tx.QueryRow(ctx,
		`SELECT next_seq, last_solve_rms FROM sessions WHERE id=$1`, sessionID,
	).Scan(&snap.NextSeq, &snap.LastSolveRMS); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
		SELECT seq, entity_type, entity_id, op, before_json, after_json
		FROM session_ops WHERE session_id=$1 ORDER BY seq`, sessionID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var o solveUndoOp
		var before, after []byte
		if err := rows.Scan(&o.Seq, &o.EntityType, &o.EntityID, &o.Op, &before, &after); err != nil {
			rows.Close()
			return err
		}
		o.BeforeJSON = before
		o.AfterJSON = after
		snap.Ops = append(snap.Ops, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = tx.Exec(ctx,
		`UPDATE sessions SET solve_undo_json=$2 WHERE id=$1`, sessionID, jsonMust(snap))
	return err
}

// writebackChangesInSession routes each solver change through recordOp so
// the seq allocator (sessions.next_seq) stays consistent with the entity
// handlers — hand-rolling a separate INSERT here would let the two
// allocators drift and collide on the (session_id, seq) primary key.
func (s *Server) writebackChangesInSession(ctx context.Context, sessionID string, changes []wire.EntityChange) error {
	if len(changes) == 0 {
		return nil
	}
	overlay, err := loadSessionOverlay(ctx, s.db, sessionID)
	if err != nil {
		return fmt.Errorf("load overlay: %w", err)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Snapshot the pre-solve journal before recordOp touches it, so undoSolve
	// can roll this writeback back within the open session.
	if err := captureSolveUndoSnapshot(ctx, tx, sessionID); err != nil {
		return fmt.Errorf("capture undo snapshot: %w", err)
	}
	now := time.Now().UTC()
	for _, c := range changes {
		before, after, err := snapshotForChange(ctx, s.db, overlay, c, now)
		if err != nil {
			return err
		}
		if err := recordOp(ctx, tx, sessionID, c.Kind, c.ID, "update", before, after); err != nil {
			return err
		}
	}
	// Propagate date bounds across the observation graph so the user
	// sees the post-propagation state in the overlay before merge.
	if err := runPropagationInTx(ctx, tx, sessionID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func snapshotForChange(ctx context.Context, db *pgxpool.Pool, overlay sessionOverlay, c wire.EntityChange, now time.Time) (before, after []byte, err error) {
	switch c.Kind {
	case entityStation:
		st, present, err := currentStation(ctx, db, overlay, c.ID)
		if err != nil {
			return nil, nil, err
		}
		if !present {
			return nil, nil, fmt.Errorf("station %s missing", c.ID)
		}
		filterNoiseStationSigma(c.After, &st)
		before = jsonMust(st)
		applyChangeToStation(&st, c.After)
		st.UpdatedAt = now
		after = jsonMust(st)
	case entityPhoto:
		p, present, err := currentPhoto(ctx, db, overlay, c.ID)
		if err != nil {
			return nil, nil, err
		}
		if !present {
			return nil, nil, fmt.Errorf("photo %s missing", c.ID)
		}
		filterNoisePhotoSigma(c.After, &p)
		before = jsonMust(p)
		applyChangeToPhoto(&p, c.After)
		p.UpdatedAt = now
		after = jsonMust(p)
	case entityControlPoint:
		cp, present, err := currentControlPoint(ctx, db, overlay, c.ID)
		if err != nil {
			return nil, nil, err
		}
		if !present {
			return nil, nil, fmt.Errorf("control_point %s missing", c.ID)
		}
		filterNoiseControlPointSigma(c.After, &cp)
		before = jsonMust(cp)
		applyChangeToControlPoint(&cp, c.After)
		cp.UpdatedAt = now
		after = jsonMust(cp)
	default:
		return nil, nil, fmt.Errorf("unknown change kind %q", c.Kind)
	}
	return before, after, nil
}

// noiseCloseSigma reports whether a freshly-computed σ/cov value is close
// enough to the prior pointer value to be treated as floating-point jitter
// from re-solving the same problem. A nil prior always returns false so a
// first-time σ population still surfaces.
//
// Tolerance: 1e-9 relative ‖ 1e-12 absolute. σ values are uncertainties in
// meters (station/CP position) or radians (photo angles); the smallest
// user-visible change is mm/µrad, well above this floor. Re-solve jitter
// from Ceres' covariance estimator typically lands in the 1e-13 to 1e-14
// range, comfortably below.
func noiseCloseSigma(prior *float64, fresh float64) bool {
	if prior == nil {
		return false
	}
	const relTol = 1e-9
	const absTol = 1e-12
	diff := math.Abs(fresh - *prior)
	return diff <= math.Max(relTol*math.Abs(*prior), absTol)
}

func filterNoiseStationSigma(after map[string]float64, st *Station) {
	for k, v := range after {
		var prior *float64
		switch k {
		case "sigma_lat":
			prior = st.SigmaLat
		case "sigma_lng":
			prior = st.SigmaLng
		case "sigma_alt":
			prior = st.SigmaAlt
		case "cov_lat_lng":
			prior = st.CovLatLng
		default:
			continue
		}
		if noiseCloseSigma(prior, v) {
			delete(after, k)
		}
	}
}

func filterNoisePhotoSigma(after map[string]float64, p *Photo) {
	for k, v := range after {
		var prior *float64
		switch k {
		case "sigma_photo_az":
			prior = p.SigmaPhotoAz
		case "sigma_photo_tilt":
			prior = p.SigmaPhotoTilt
		case "sigma_photo_roll":
			prior = p.SigmaPhotoRoll
		case "sigma_size_rad":
			prior = p.SigmaSizeRad
		case "sigma_dist_k1":
			prior = p.SigmaDistK1
		case "sigma_dist_k2":
			prior = p.SigmaDistK2
		default:
			continue
		}
		if noiseCloseSigma(prior, v) {
			delete(after, k)
		}
	}
}

func filterNoiseControlPointSigma(after map[string]float64, cp *ControlPoint) {
	for k, v := range after {
		var prior *float64
		switch k {
		case "sigma_est_lat":
			prior = cp.SigmaEstLat
		case "sigma_est_lng":
			prior = cp.SigmaEstLng
		case "sigma_est_alt":
			prior = cp.SigmaEstAlt
		case "cov_est_lat_lng":
			prior = cp.CovEstLatLng
		default:
			continue
		}
		if noiseCloseSigma(prior, v) {
			delete(after, k)
		}
	}
}

func applyChangeToStation(st *Station, after map[string]float64) {
	for k, v := range after {
		switch k {
		case "lat":
			st.Lat = v
		case "lng":
			st.Lng = v
		case "alt":
			st.Alt = v
		case "sigma_lat":
			s := v
			st.SigmaLat = &s
		case "sigma_lng":
			s := v
			st.SigmaLng = &s
		case "sigma_alt":
			s := v
			st.SigmaAlt = &s
		case "cov_lat_lng":
			s := v
			st.CovLatLng = &s
		}
	}
}

func applyChangeToPhoto(p *Photo, after map[string]float64) {
	for k, v := range after {
		switch k {
		case "photo_az":
			p.PhotoAz = v
		case "photo_tilt":
			p.PhotoTilt = v
		case "photo_roll":
			p.PhotoRoll = v
		case "size_rad":
			p.SizeRad = v
		case "dist_k1":
			p.DistK1 = v
		case "dist_k2":
			p.DistK2 = v
		case "sigma_photo_az":
			s := v
			p.SigmaPhotoAz = &s
		case "sigma_photo_tilt":
			s := v
			p.SigmaPhotoTilt = &s
		case "sigma_photo_roll":
			s := v
			p.SigmaPhotoRoll = &s
		case "sigma_size_rad":
			s := v
			p.SigmaSizeRad = &s
		case "sigma_dist_k1":
			s := v
			p.SigmaDistK1 = &s
		case "sigma_dist_k2":
			s := v
			p.SigmaDistK2 = &s
		}
	}
}

func applyChangeToControlPoint(cp *ControlPoint, after map[string]float64) {
	for k, v := range after {
		val := v
		switch k {
		case "est_lat":
			cp.EstLat = &val
		case "est_lng":
			cp.EstLng = &val
		case "est_alt":
			cp.EstAlt = &val
		case "sigma_est_lat":
			cp.SigmaEstLat = &val
		case "sigma_est_lng":
			cp.SigmaEstLng = &val
		case "sigma_est_alt":
			cp.SigmaEstAlt = &val
		case "cov_est_lat_lng":
			cp.CovEstLatLng = &val
		}
	}
}
