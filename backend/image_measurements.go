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
	patch, ok := parsePatch(w, r)
	if !ok {
		return
	}
	b := newUpdateBuilder(id)
	for _, key := range []string{"u", "v"} {
		if v, present, err := patch.Float64(key); present {
			if err != nil || !validUV(v) {
				writeError(w, http.StatusBadRequest, "u/v must be in [0, 1]")
				return
			}
			b.Set(key, v)
		}
	}
	if v, present, err := patch.NullableID("control_point_id"); present {
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		b.Set("control_point_id", v)
	}
	if b.Empty() {
		writeError(w, http.StatusBadRequest, "no updatable fields")
		return
	}
	var im ImageMeasurement
	err := s.db.QueryRow(r.Context(), b.Query("image_measurements", imageMeasurementCols), b.Args()...).Scan(
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
