package main

import "net/http"

type latLngReq struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

func (req latLngReq) validate() string {
	if !validLat(req.Lat) {
		return "lat out of range"
	}
	if !validLng(req.Lng) {
		return "lng out of range"
	}
	return ""
}

func (s *Server) postMapPOI(w http.ResponseWriter, r *http.Request) {
	locID := requireID(w, r, "id")
	if locID == "" {
		return
	}
	var req latLngReq
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := req.validate(); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	id := newID()
	const q = `INSERT INTO map_pois (id, location_id, lat, lng) VALUES ($1, $2, $3, $4)
	           RETURNING id, location_id, lat, lng, created_at, updated_at`
	var m MapPOI
	err := s.db.QueryRow(r.Context(), q, id, locID, req.Lat, req.Lng).Scan(
		&m.ID, &m.LocationID, &m.Lat, &m.Lng, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (s *Server) putMapPOI(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req latLngReq
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := req.validate(); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	const q = `UPDATE map_pois SET lat=$2, lng=$3, updated_at=NOW() WHERE id=$1
	           RETURNING id, location_id, lat, lng, created_at, updated_at`
	var m MapPOI
	err := s.db.QueryRow(r.Context(), q, id, req.Lat, req.Lng).Scan(
		&m.ID, &m.LocationID, &m.Lat, &m.Lng, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) deleteMapPOI(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM map_pois WHERE id = $1`, id)
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
