package main

import "net/http"

func (s *Server) postImagePOI(w http.ResponseWriter, r *http.Request) {
	photoID := requireID(w, r, "id")
	if photoID == "" {
		return
	}
	var req ImagePOIPatch
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateImagePOIPatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	id := newID()
	const q = `INSERT INTO image_pois (id, photo_id, u, v, map_poi_id)
	           VALUES ($1, $2, $3, $4, $5)
	           RETURNING id, photo_id, u, v, map_poi_id, created_at, updated_at`
	var ip ImagePOI
	err := s.db.QueryRow(r.Context(), q, id, photoID, req.U, req.V, req.MapPoiID).Scan(
		&ip.ID, &ip.PhotoID, &ip.U, &ip.V, &ip.MapPoiID, &ip.CreatedAt, &ip.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, ip)
}

func (s *Server) putImagePOI(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req ImagePOIPatch
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateImagePOIPatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	const q = `UPDATE image_pois SET u=$2, v=$3, map_poi_id=$4, updated_at=NOW()
	           WHERE id=$1
	           RETURNING id, photo_id, u, v, map_poi_id, created_at, updated_at`
	var ip ImagePOI
	err := s.db.QueryRow(r.Context(), q, id, req.U, req.V, req.MapPoiID).Scan(
		&ip.ID, &ip.PhotoID, &ip.U, &ip.V, &ip.MapPoiID, &ip.CreatedAt, &ip.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ip)
}

func (s *Server) deleteImagePOI(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM image_pois WHERE id = $1`, id)
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
