package main

import "net/http"

const mapMeasurementCols = `id, location_id, lat, lng, control_point_id, created_at, updated_at`

func (s *Server) postMapMeasurement(w http.ResponseWriter, r *http.Request) {
	locID := requireID(w, r, "id")
	if locID == "" {
		return
	}
	var req MapMeasurementRequest
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateMapMeasurementRequest(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	id := newID()
	q := `INSERT INTO map_measurements (id, location_id, lat, lng, control_point_id)
	      VALUES ($1, $2, $3, $4, $5)
	      RETURNING ` + mapMeasurementCols
	var m MapMeasurement
	err := s.db.QueryRow(r.Context(), q, id, locID, req.Lat, req.Lng, req.ControlPointID).Scan(
		&m.ID, &m.LocationID, &m.Lat, &m.Lng, &m.ControlPointID, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (s *Server) putMapMeasurement(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req MapMeasurementRequest
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateMapMeasurementRequest(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	q := `UPDATE map_measurements SET lat=$2, lng=$3, control_point_id=$4, updated_at=NOW()
	      WHERE id=$1
	      RETURNING ` + mapMeasurementCols
	var m MapMeasurement
	err := s.db.QueryRow(r.Context(), q, id, req.Lat, req.Lng, req.ControlPointID).Scan(
		&m.ID, &m.LocationID, &m.Lat, &m.Lng, &m.ControlPointID, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) deleteMapMeasurement(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM map_measurements WHERE id = $1`, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
