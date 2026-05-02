package main

import "net/http"

const mapMeasurementCols = `id, lat, lng, control_point_id, created_at, updated_at`

func (s *Server) postMapMeasurement(w http.ResponseWriter, r *http.Request) {
	var req MapMeasurementRequest
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateMapMeasurementRequest(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	id := newID()
	q := `INSERT INTO map_measurements (id, lat, lng, control_point_id)
	      VALUES ($1, $2, $3, $4)
	      RETURNING ` + mapMeasurementCols
	var m MapMeasurement
	err := s.db.QueryRow(r.Context(), q, id, req.Lat, req.Lng, req.ControlPointID).Scan(
		&m.ID, &m.Lat, &m.Lng, &m.ControlPointID, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (s *Server) listMapMeasurements(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT `+mapMeasurementCols+` FROM map_measurements ORDER BY created_at`)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer rows.Close()
	out := []MapMeasurement{}
	for rows.Next() {
		var m MapMeasurement
		if err := rows.Scan(&m.ID, &m.Lat, &m.Lng, &m.ControlPointID, &m.CreatedAt, &m.UpdatedAt); err != nil {
			writeErrorFromDB(w, err)
			return
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
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
		&m.ID, &m.Lat, &m.Lng, &m.ControlPointID, &m.CreatedAt, &m.UpdatedAt)
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
