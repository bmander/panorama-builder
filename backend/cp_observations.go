package main

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// cp_observations is the per-station-per-CP visibility ledger. status is
// present / absent / obscured. Writes funnel through the session journal
// like every other entity.

const cpObservationCols = `id, station_id, control_point_id, status, created_at, updated_at`

func scanCpObservation(row pgx.Row) (CpObservation, error) {
	var o CpObservation
	var status string
	if err := row.Scan(&o.ID, &o.StationID, &o.ControlPointID, &status, &o.CreatedAt, &o.UpdatedAt); err != nil {
		return o, err
	}
	o.Status = CpObservationStatus(status)
	return o, nil
}

func validateStatus(status CpObservationStatus) string {
	if !status.Valid() {
		return "invalid status"
	}
	return ""
}

func (s *Server) postCpObservation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	stationID := requireID(w, r, "id")
	if stationID == "" {
		return
	}
	var req CpObservationCreate
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateStatus(req.Status); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if !validID(req.ControlPointID) {
		writeError(w, http.StatusBadRequest, "invalid control_point_id")
		return
	}
	ctx := r.Context()

	// Existence check on (station, CP) pair so we return 409 (conflict)
	// rather than 500 from the unique-constraint violation at merge.
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if existing, err := s.findCpObservationByPair(ctx, overlay, stationID, req.ControlPointID); err != nil {
		writeErrorFromDB(w, err)
		return
	} else if existing != nil {
		writeError(w, http.StatusConflict, "cp_observation already exists for this (station, control_point)")
		return
	}

	id := newID()
	now := time.Now().UTC()
	o := CpObservation{
		ID:             id,
		StationID:      stationID,
		ControlPointID: req.ControlPointID,
		Status:         req.Status,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := s.recordOpDirect(ctx, sess.ID, entityCPObservation, id, "insert", nil, jsonMust(o)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, o)
}

func (s *Server) putCpObservation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req CpObservationUpdate
	if !parseJSON(w, r, &req) {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentCpObservation(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	before := jsonMust(cur)
	if req.Status != nil {
		cur.Status = *req.Status
	}
	if msg := validateStatus(cur.Status); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	cur.UpdatedAt = time.Now().UTC()
	if err := s.recordOpDirect(ctx, sess.ID, entityCPObservation, id, "update", before, jsonMust(cur)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cur)
}

func (s *Server) deleteCpObservation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentCpObservation(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	// present rows backed by image_measurement evidence can't be deleted
	// without leaving an orphaned pixel pin claiming the CP is observed.
	if cur.Status == Present {
		hasIM, err := s.hasImageMeasurementForStationCP(ctx, overlay, cur.StationID, cur.ControlPointID)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		if hasIM {
			writeError(w, http.StatusConflict, "delete the image_measurement evidence first")
			return
		}
	}
	if err := s.recordOpDirect(ctx, sess.ID, entityCPObservation, id, "delete", jsonMust(cur), nil); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// listCpObservationsByControlPoint returns rows referencing the given CP,
// overlay-aware when a session is supplied.
func (s *Server) listCpObservationsByControlPoint(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, sessOK := s.maybeOverlay(w, r)
	if !sessOK {
		return
	}
	if overlay != nil {
		if _, present, err := currentControlPoint(ctx, s.db, overlay, id); err != nil {
			writeErrorFromDB(w, err)
			return
		} else if !present {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
	} else {
		var exists bool
		if err := s.db.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM control_points WHERE id = $1)`, id).Scan(&exists); err != nil {
			writeErrorFromDB(w, err)
			return
		}
		if !exists {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
	}

	base, err := s.cpObservationsByCP(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if overlay == nil {
		writeJSON(w, http.StatusOK, base)
		return
	}
	out, err := mergeOverlay(base, overlay[entityCPObservation],
		func(o CpObservation) string { return o.ID },
		decodeJSON[CpObservation],
		func(o CpObservation) bool { return o.ControlPointID == id })
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// maybeOverlay loads the session overlay if X-Session-Id is set.
// Returns (nil, true) for no-session reads.
func (s *Server) maybeOverlay(w http.ResponseWriter, r *http.Request) (sessionOverlay, bool) {
	sess, ok := s.tryLoadSession(w, r)
	if !ok {
		return nil, false
	}
	if sess == nil {
		return nil, true
	}
	overlay, err := loadSessionOverlay(r.Context(), s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return nil, false
	}
	return overlay, true
}

// --- Read helpers ---

func currentCpObservation(ctx context.Context, db *pgxpool.Pool, overlay sessionOverlay, id string) (CpObservation, bool, error) {
	return currentEntity(ctx, db, overlay, entityCPObservation, id, scanCpObservation,
		`SELECT `+cpObservationCols+` FROM cp_observations WHERE id=$1`)
}

// findCpObservationByPair returns the existing row (overlay-aware) for the
// (station, cp) pair, or nil if none exists. Used by the create handler to
// turn the unique-constraint violation into a friendly 409.
func (s *Server) findCpObservationByPair(ctx context.Context, overlay sessionOverlay, stationID, cpID string) (*CpObservation, error) {
	for _, st := range overlay[entityCPObservation] {
		if st.deleted || st.after == nil {
			continue
		}
		o, err := decodeJSON[CpObservation](st.after)
		if err != nil {
			return nil, err
		}
		if o.StationID == stationID && o.ControlPointID == cpID {
			return &o, nil
		}
	}
	o, err := scanCpObservation(s.db.QueryRow(ctx,
		`SELECT `+cpObservationCols+` FROM cp_observations WHERE station_id=$1 AND control_point_id=$2`,
		stationID, cpID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if st, ok := overlay[entityCPObservation][o.ID]; ok && st.deleted {
		return nil, nil
	}
	return &o, nil
}

// hasImageMeasurementForStationCP returns true when at least one
// image_measurement on a photo of the given station references cpID
// (post-overlay).
func (s *Server) hasImageMeasurementForStationCP(ctx context.Context, overlay sessionOverlay, stationID, cpID string) (bool, error) {
	ims, err := s.imageMeasurementsForCP(ctx, overlay, cpID)
	if err != nil {
		return false, err
	}
	for _, im := range ims {
		p, present, err := currentPhoto(ctx, s.db, overlay, im.PhotoID)
		if err != nil {
			return false, err
		}
		if !present {
			continue
		}
		if p.StationID == stationID {
			return true, nil
		}
	}
	return false, nil
}

func (s *Server) cpObservationsByCP(ctx context.Context, cpID string) ([]CpObservation, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+cpObservationCols+` FROM cp_observations WHERE control_point_id=$1 ORDER BY created_at`, cpID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CpObservation{}
	for rows.Next() {
		o, err := scanCpObservation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (s *Server) cpObservationsByStation(ctx context.Context, stationID string) ([]CpObservation, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+cpObservationCols+` FROM cp_observations WHERE station_id=$1 ORDER BY created_at`, stationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CpObservation{}
	for rows.Next() {
		o, err := scanCpObservation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// allCpObservations returns every cp_observation row across all stations. The
// world read returns the full set (not just the focus station's) so the client
// can keep one hydration and re-focus any station without refetching.
func (s *Server) allCpObservations(ctx context.Context) ([]CpObservation, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+cpObservationCols+` FROM cp_observations ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CpObservation{}
	for rows.Next() {
		o, err := scanCpObservation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// collectCpObservationsForStation returns rows currently assigned to the
// station after the session overlay is applied. Used by the cascade walker
// in deleteStationInSession.
func (s *Server) collectCpObservationsForStation(ctx context.Context, overlay sessionOverlay, stationID string) ([]CpObservation, error) {
	base, err := s.cpObservationsByStation(ctx, stationID)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityCPObservation],
		func(o CpObservation) string { return o.ID },
		decodeJSON[CpObservation],
		func(o CpObservation) bool { return o.StationID == stationID })
}

// collectCpObservationsForCP is the symmetric helper for delete-CP cascade.
func (s *Server) collectCpObservationsForCP(ctx context.Context, overlay sessionOverlay, cpID string) ([]CpObservation, error) {
	base, err := s.cpObservationsByCP(ctx, cpID)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityCPObservation],
		func(o CpObservation) string { return o.ID },
		decodeJSON[CpObservation],
		func(o CpObservation) bool { return o.ControlPointID == cpID })
}
