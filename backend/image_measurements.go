package main

import "net/http"

const imageMeasurementCols = `id, photo_id, u, v, control_point_id, created_at, updated_at`

func (s *Server) postImageMeasurement(w http.ResponseWriter, r *http.Request) {
	photoID := requireID(w, r, "id")
	if photoID == "" {
		return
	}
	var req ImageMeasurementPatch
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateImageMeasurementPatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	id := newID()
	q := `INSERT INTO image_measurements (id, photo_id, u, v, control_point_id)
	      VALUES ($1, $2, $3, $4, $5)
	      RETURNING ` + imageMeasurementCols
	var im ImageMeasurement
	err := s.db.QueryRow(r.Context(), q, id, photoID, req.U, req.V, req.ControlPointID).Scan(
		&im.ID, &im.PhotoID, &im.U, &im.V, &im.ControlPointID, &im.CreatedAt, &im.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, im)
}

func (s *Server) putImageMeasurement(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req ImageMeasurementPatch
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateImageMeasurementPatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	q := `UPDATE image_measurements SET u=$2, v=$3, control_point_id=$4, updated_at=NOW()
	      WHERE id=$1
	      RETURNING ` + imageMeasurementCols
	var im ImageMeasurement
	err := s.db.QueryRow(r.Context(), q, id, req.U, req.V, req.ControlPointID).Scan(
		&im.ID, &im.PhotoID, &im.U, &im.V, &im.ControlPointID, &im.CreatedAt, &im.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, im)
}

func (s *Server) deleteImageMeasurement(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM image_measurements WHERE id = $1`, id)
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
