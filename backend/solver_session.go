package main

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/bmander/panorama-builder/backend/solver"
)

// loadSingleStationProblemSession restricts the overlaid joint set to one
// station and the photos / observations / CPs that anchor to it. ok=false
// means the focus station isn't in the (overlaid) station set.
func (s *Server) loadSingleStationProblemSession(ctx context.Context, sess *Session, stationID string) (solver.Problem, bool, error) {
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		return solver.Problem{}, false, err
	}
	stations, err := s.loadAllSolverStationsOverlaid(ctx, overlay)
	if err != nil {
		return solver.Problem{}, false, err
	}
	i := slices.IndexFunc(stations, func(st solver.Station) bool { return st.ID == stationID })
	if i < 0 {
		return solver.Problem{}, false, nil
	}
	station := stations[i]
	allPhotos, err := s.loadAllSolverPhotosOverlaid(ctx, overlay)
	if err != nil {
		return solver.Problem{}, false, err
	}
	photos := filterSlice(allPhotos, func(p solver.Photo) bool { return p.StationID == stationID })
	allObs, err := s.loadAllSolverObservationsOverlaid(ctx, overlay)
	if err != nil {
		return solver.Problem{}, false, err
	}
	photoIDSet := idSet(photos, func(p solver.Photo) string { return p.ID })
	var obs []solver.Observation
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
		return solver.Problem{}, false, err
	}
	cps := filterByIDSet(allCPs, func(cp solver.ControlPoint) string { return cp.ID }, cpIDSet)
	cons, err := s.loadProblemCPConstraintsOverlaid(ctx, overlay, cps)
	if err != nil {
		return solver.Problem{}, false, err
	}
	return solver.Problem{
		Stations: []solver.Station{station}, Photos: photos,
		ControlPoints: cps, Observations: obs,
		CPConstraints: cons,
	}, true, nil
}

// loadSingleCPProblemSession restricts the overlaid joint set to one CP and
// the photos / stations that observe it, seeding a NULL-location CP from
// the mean of its contributing stations.
func (s *Server) loadSingleCPProblemSession(ctx context.Context, sess *Session, cpID string) (solver.Problem, bool, error) {
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		return solver.Problem{}, false, err
	}
	allCPs, _, err := s.loadAllSolverCPsOverlaid(ctx, overlay)
	if err != nil {
		return solver.Problem{}, false, err
	}
	i := slices.IndexFunc(allCPs, func(c solver.ControlPoint) bool { return c.ID == cpID })
	if i < 0 {
		return solver.Problem{}, false, nil
	}
	cp := allCPs[i]
	allObs, err := s.loadAllSolverObservationsOverlaid(ctx, overlay)
	if err != nil {
		return solver.Problem{}, false, err
	}
	var obs []solver.Observation
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
		return solver.Problem{}, false, err
	}
	var photos []solver.Photo
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
		return solver.Problem{}, false, err
	}
	stations := filterByIDSet(allStations, func(st solver.Station) string { return st.ID }, stationIDSet)
	if cp.EstLat == 0 && cp.EstLng == 0 {
		if lat, lng, ok := meanStationLatLng(stations); ok {
			cp.EstLat = lat
			cp.EstLng = lng
		}
	}
	cps := []solver.ControlPoint{cp}
	cons, err := s.loadProblemCPConstraintsOverlaid(ctx, overlay, cps)
	if err != nil {
		return solver.Problem{}, false, err
	}
	return solver.Problem{
		Stations: stations, Photos: photos,
		ControlPoints: cps, Observations: obs,
		CPConstraints: cons,
	}, true, nil
}

func (s *Server) loadJointProblemSession(ctx context.Context, sess *Session) (solver.Problem, []string, error) {
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		return solver.Problem{}, nil, err
	}
	stations, err := s.loadAllSolverStationsOverlaid(ctx, overlay)
	if err != nil {
		return solver.Problem{}, nil, err
	}
	photos, err := s.loadAllSolverPhotosOverlaid(ctx, overlay)
	if err != nil {
		return solver.Problem{}, nil, err
	}
	cps, nullLoc, err := s.loadAllSolverCPsOverlaid(ctx, overlay)
	if err != nil {
		return solver.Problem{}, nil, err
	}
	obs, err := s.loadAllSolverObservationsOverlaid(ctx, overlay)
	if err != nil {
		return solver.Problem{}, nil, err
	}
	obs = filterOrphanObservations(obs, cps, photos)
	cps, obs, seeded := seedNullLocationCPs(cps, nullLoc, obs, photos, stations)
	cons, err := s.loadProblemCPConstraintsOverlaid(ctx, overlay, cps)
	if err != nil {
		return solver.Problem{}, nil, err
	}
	return solver.Problem{
		Stations: stations, Photos: photos,
		ControlPoints: cps, Observations: obs,
		CPConstraints: cons,
	}, seeded, nil
}

// filterOrphanObservations drops observations whose photo or CP isn't in
// the overlaid problem. Without it, a session-only delete (journaled but
// not yet cascaded into main) leaves dangling obs and the solver's
// cpIdx/photoIdx miss silently resolves to entity 0.
func filterOrphanObservations(obs []solver.Observation, cps []solver.ControlPoint, photos []solver.Photo) []solver.Observation {
	cpIDs := idSet(cps, func(cp solver.ControlPoint) string { return cp.ID })
	photoIDs := idSet(photos, func(p solver.Photo) string { return p.ID })
	out := make([]solver.Observation, 0, len(obs))
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

func (s *Server) loadAllSolverStationsOverlaid(ctx context.Context, overlay sessionOverlay) ([]solver.Station, error) {
	base, err := loadAllStations(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityStation],
		func(st solver.Station) string { return st.ID },
		decodeSolverStation,
		func(solver.Station) bool { return true })
}

func decodeSolverStation(b []byte) (solver.Station, error) {
	var st Station
	if err := json.Unmarshal(b, &st); err != nil {
		return solver.Station{}, err
	}
	return solver.Station{
		ID: st.ID, Lat: st.Lat, Lng: st.Lng, Alt: st.Alt,
		Locks:     solver.StationLocks{Lat: st.LockLat, Lng: st.LockLng, Alt: st.LockAlt},
		UpdatedAt: st.UpdatedAt,
	}, nil
}

func (s *Server) loadAllSolverPhotosOverlaid(ctx context.Context, overlay sessionOverlay) ([]solver.Photo, error) {
	base, err := loadAllPhotos(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityPhoto],
		func(p solver.Photo) string { return p.ID },
		decodeSolverPhoto,
		func(solver.Photo) bool { return true })
}

func decodeSolverPhoto(b []byte) (solver.Photo, error) {
	var p Photo
	if err := json.Unmarshal(b, &p); err != nil {
		return solver.Photo{}, err
	}
	return solver.Photo{
		ID: p.ID, StationID: p.StationID,
		Pose: solver.Pose{
			Aspect: p.Aspect, PhotoAz: p.PhotoAz, PhotoTilt: p.PhotoTilt,
			PhotoRoll: p.PhotoRoll, SizeRad: p.SizeRad,
			K1: p.DistK1, K2: p.DistK2,
		},
		Locks: solver.PhotoLocks{
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
func (s *Server) loadAllSolverCPsOverlaid(ctx context.Context, overlay sessionOverlay) ([]solver.ControlPoint, map[string]bool, error) {
	base, baseNull, err := loadAllControlPoints(ctx, s.db)
	if err != nil {
		return nil, nil, err
	}
	merged, err := mergeOverlay(base, overlay[entityControlPoint],
		func(cp solver.ControlPoint) string { return cp.ID },
		decodeSolverCP,
		func(solver.ControlPoint) bool { return true })
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

func decodeSolverCP(b []byte) (solver.ControlPoint, error) {
	var cp ControlPoint
	if err := json.Unmarshal(b, &cp); err != nil {
		return solver.ControlPoint{}, err
	}
	out := solver.ControlPoint{
		ID:        cp.ID,
		Locks:     solver.CPLocks{EstLat: cp.LockEstLat, EstLng: cp.LockEstLng, EstAlt: cp.LockEstAlt},
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

func (s *Server) loadAllSolverObservationsOverlaid(ctx context.Context, overlay sessionOverlay) ([]solver.Observation, error) {
	base, err := loadAllObservations(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityImageMeasurement],
		func(o solver.Observation) string { return o.ID },
		decodeSolverObservation,
		// Drop measurements with no CP link: the solver only consumes
		// observations that anchor to a control point.
		func(o solver.Observation) bool { return o.ControlPointID != "" })
}

func decodeSolverObservation(b []byte) (solver.Observation, error) {
	var im ImageMeasurement
	if err := json.Unmarshal(b, &im); err != nil {
		return solver.Observation{}, err
	}
	out := solver.Observation{ID: im.ID, PhotoID: im.PhotoID, U: im.U, V: im.V}
	if im.ControlPointID != nil {
		out.ControlPointID = *im.ControlPointID
	}
	return out, nil
}

// loadProblemCPConstraintsOverlaid: the solver.CPConstraint type drops the
// id (the solver doesn't need it), so we wrap ids alongside for the
// overlay lookup and unwrap on the way out.
func (s *Server) loadProblemCPConstraintsOverlaid(ctx context.Context, overlay sessionOverlay, cps []solver.ControlPoint) ([]solver.CPConstraint, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, cp_a_id, cp_b_id, constraint_type FROM cp_constraints`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type idConstraint struct {
		ID string
		C  solver.CPConstraint
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
			return idConstraint{ID: c.ID, C: solver.CPConstraint{
				CpAID: c.CpAId, CpBID: c.CpBId, ConstraintType: string(c.ConstraintType),
			}}, nil
		},
		func(idConstraint) bool { return true })
	if err != nil {
		return nil, err
	}
	out := make([]solver.CPConstraint, len(merged))
	for i, ic := range merged {
		out[i] = ic.C
	}
	return filterCPConstraintsByCPSet(out, cps), nil
}

// writebackChangesInSession routes each solver change through recordOp so
// the seq allocator (sessions.next_seq) stays consistent with the entity
// handlers — hand-rolling a separate INSERT here would let the two
// allocators drift and collide on the (session_id, seq) primary key.
func (s *Server) writebackChangesInSession(ctx context.Context, sessionID string, changes []solver.EntityChange) error {
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
	// Propagate date bounds across the observation graph and journal any
	// CP/station whose derived window changes — so the user sees the
	// post-propagation state in the session overlay before merge. The
	// overlay loaded above predates the solver's own writes recorded in
	// this loop, but those writes only touch est_*/σ (not date-graph
	// inputs), so the staleness is harmless.
	if err := propagateDatesInSession(ctx, tx, sessionID, overlay); err != nil {
		return fmt.Errorf("propagate dates: %w", err)
	}
	return tx.Commit(ctx)
}

func snapshotForChange(ctx context.Context, db *pgxpool.Pool, overlay sessionOverlay, c solver.EntityChange, now time.Time) (before, after []byte, err error) {
	switch c.Kind {
	case entityStation:
		st, present, err := currentStation(ctx, db, overlay, c.ID)
		if err != nil {
			return nil, nil, err
		}
		if !present {
			return nil, nil, fmt.Errorf("station %s missing", c.ID)
		}
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
		before = jsonMust(cp)
		applyChangeToControlPoint(&cp, c.After)
		cp.UpdatedAt = now
		after = jsonMust(cp)
	default:
		return nil, nil, fmt.Errorf("unknown change kind %q", c.Kind)
	}
	return before, after, nil
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
		}
	}
}
