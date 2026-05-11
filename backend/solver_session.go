package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/bmander/panorama-builder/backend/solver"
)

// Session-aware solver entry points. Session-mode solves run against
// main+intent and return preview-only results; the canonical writeback is
// done by solveAndApplyAtMerge at merge time.

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

// solveAndApplyAtMerge runs the joint solver against main, writes its result
// back to main, and journals the derived changes onto session_ops so revert
// can undo them. Returns the touched (entity_type, entity_id) pairs for
// entity_commits bookkeeping. Solver failures (divergence, under-constrained
// gauge) are non-fatal — the merge keeps just the intent ops. Called inside
// the merge tx with solveMu held to keep concurrent /api/solve/* out of the
// way.
func (s *Server) solveAndApplyAtMerge(ctx context.Context, tx pgx.Tx, sessionID string) ([]netOp, error) {
	s.solveMu.Lock()
	defer s.solveMu.Unlock()

	prob, seeded, err := s.loadJointProblem(ctx)
	if err != nil {
		return nil, fmt.Errorf("merge solve load: %w", err)
	}
	res, err := solver.SolveJointWithSeed(prob, seeded, solver.Config{
		Mode: solver.ModeJoint, MaxIters: 200,
	})
	if err != nil {
		log.Printf("merge solve: %v", err)
		return nil, nil
	}
	if res.Diverged || len(res.Changes) == 0 {
		return nil, nil
	}

	derived := make([]netOp, 0, len(res.Changes))
	for _, c := range res.Changes {
		before, after, err := loadApplyAndUpdate(ctx, tx, c)
		if err != nil {
			return nil, err
		}
		if err := upsertSessionOp(ctx, tx, sessionID, c.Kind, c.ID, before, after); err != nil {
			return nil, err
		}
		derived = append(derived, netOp{EntityType: c.Kind, EntityID: c.ID})
	}
	return derived, nil
}

// loadApplyAndUpdate reads the row from main (the before snapshot), folds
// the solver's After deltas into it, writes the full row back via the
// shared updateEntityFromJSON path, and returns (before, after) JSON. The
// merge tx is SERIALIZABLE with solveMu held, so there's no race that
// would justify a FOR UPDATE read.
func loadApplyAndUpdate(ctx context.Context, tx pgx.Tx, c solver.EntityChange) (before, after []byte, err error) {
	switch c.Kind {
	case entityStation:
		st, err := scanStation(tx.QueryRow(ctx, `SELECT `+stationCols+` FROM stations WHERE id=$1`, c.ID))
		if err != nil {
			return nil, nil, err
		}
		before = jsonMust(st)
		applyChangeToStation(&st, c.After)
		st.UpdatedAt = time.Now().UTC()
		after = jsonMust(st)
	case entityPhoto:
		p, err := scanPhoto(tx.QueryRow(ctx, `SELECT `+photoCols+` FROM photos WHERE id=$1`, c.ID))
		if err != nil {
			return nil, nil, err
		}
		before = jsonMust(p)
		applyChangeToPhoto(&p, c.After)
		p.UpdatedAt = time.Now().UTC()
		after = jsonMust(p)
	case entityControlPoint:
		cp, err := scanControlPoint(tx.QueryRow(ctx, `SELECT `+controlPointCols+` FROM control_points WHERE id=$1`, c.ID))
		if err != nil {
			return nil, nil, err
		}
		before = jsonMust(cp)
		applyChangeToControlPoint(&cp, c.After)
		cp.UpdatedAt = time.Now().UTC()
		after = jsonMust(cp)
	default:
		return nil, nil, fmt.Errorf("unknown change kind %q", c.Kind)
	}
	if err := updateEntityFromJSON(ctx, tx, c.Kind, c.ID, after); err != nil {
		return nil, nil, fmt.Errorf("apply %s/%s: %w", c.Kind, c.ID, err)
	}
	return before, after, nil
}

// upsertSessionOp folds the solver's change into the session journal. If
// the user already had an intent op on this entity, only after_json is
// replaced — `before` stays as the pre-intent snapshot so revert undoes
// the full commit, not just the solver's increment.
func upsertSessionOp(ctx context.Context, tx pgx.Tx, sessionID, entityType, entityID string, before, after []byte) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO session_ops (session_id, seq, entity_type, entity_id, op, before_json, after_json)
		VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM session_ops WHERE session_id=$1),
		        $2, $3, 'update', $4, $5)
		ON CONFLICT (session_id, entity_type, entity_id)
		DO UPDATE SET after_json = EXCLUDED.after_json`,
		sessionID, entityType, entityID, before, after)
	return err
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
		}
	}
}
