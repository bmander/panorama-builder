package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

const controlPointCols = `id, description, est_lat, est_lng, est_alt, created_at, updated_at`

func scanControlPoint(row pgx.Row) (ControlPoint, error) {
	var cp ControlPoint
	err := row.Scan(&cp.ID, &cp.Description, &cp.EstLat, &cp.EstLng, &cp.EstAlt, &cp.CreatedAt, &cp.UpdatedAt)
	return cp, err
}

func (s *Server) postControlPoint(w http.ResponseWriter, r *http.Request) {
	var req ControlPointPatch
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateControlPointPatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	desc := ""
	if req.Description != nil {
		desc = *req.Description
	}
	id := newID()
	q := `INSERT INTO control_points (id, description, est_lat, est_lng, est_alt)
	      VALUES ($1, $2, $3, $4, $5)
	      RETURNING ` + controlPointCols
	cp, err := scanControlPoint(s.db.QueryRow(r.Context(), q, id, desc, req.EstLat, req.EstLng, req.EstAlt))
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, cp)
}

func (s *Server) listControlPoints(w http.ResponseWriter, r *http.Request) {
	bbox := r.URL.Query().Get("bbox")
	var sql string
	var args []any
	if bbox != "" {
		parts := strings.Split(bbox, ",")
		if len(parts) != 4 {
			writeError(w, http.StatusBadRequest, "bbox must be minLng,minLat,maxLng,maxLat")
			return
		}
		v := make([]float64, 4)
		for i, s := range parts {
			f, err := strconv.ParseFloat(s, 64)
			if err != nil {
				writeError(w, http.StatusBadRequest, "bbox value not a number")
				return
			}
			v[i] = f
		}
		sql = `SELECT ` + controlPointCols + ` FROM control_points
		       WHERE est_lat IS NOT NULL AND est_lng IS NOT NULL
		         AND ST_MakeEnvelope($1, $2, $3, $4, 4326)
		             && ST_SetSRID(ST_MakePoint(est_lng, est_lat), 4326)
		       ORDER BY created_at DESC LIMIT 1000`
		args = []any{v[0], v[1], v[2], v[3]}
	} else {
		sql = `SELECT ` + controlPointCols + ` FROM control_points
		       ORDER BY created_at DESC LIMIT 1000`
	}
	cur, err := s.db.Query(r.Context(), sql, args...)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer cur.Close()
	out := []ControlPoint{}
	for cur.Next() {
		cp, err := scanControlPoint(cur)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		out = append(out, cp)
	}
	if err := cur.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) getControlPoint(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	q := `SELECT ` + controlPointCols + ` FROM control_points WHERE id = $1`
	cp, err := scanControlPoint(s.db.QueryRow(r.Context(), q, id))
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cp)
}

func (s *Server) putControlPoint(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req ControlPointPatch
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateControlPointPatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	// COALESCE the existing value when a field is omitted from the patch.
	q := `UPDATE control_points SET
	        description = COALESCE($2, description),
	        est_lat     = $3,
	        est_lng     = $4,
	        est_alt     = $5,
	        updated_at  = NOW()
	      WHERE id = $1
	      RETURNING ` + controlPointCols
	cp, err := scanControlPoint(s.db.QueryRow(r.Context(), q, id, req.Description, req.EstLat, req.EstLng, req.EstAlt))
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cp)
}

func (s *Server) deleteControlPoint(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM control_points WHERE id = $1`, id)
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

func (s *Server) listControlPointObservations(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	// Confirm the CP exists so the caller gets 404 (not an empty payload) when
	// the id is wrong. Cheap: control_points is small and id-indexed.
	var exists bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM control_points WHERE id = $1)`, id).Scan(&exists); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	images := []ControlPointImageObservation{}
	imRows, err := s.db.Query(r.Context(), `
		SELECT im.id, im.photo_id, im.u, im.v, p.location_id, l.name
		FROM image_measurements im
		JOIN photos p    ON p.id = im.photo_id
		JOIN locations l ON l.id = p.location_id
		WHERE im.control_point_id = $1
		ORDER BY im.created_at`, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	for imRows.Next() {
		var o ControlPointImageObservation
		if err := imRows.Scan(&o.ID, &o.PhotoID, &o.U, &o.V, &o.LocationID, &o.LocationName); err != nil {
			imRows.Close()
			writeErrorFromDB(w, err)
			return
		}
		images = append(images, o)
	}
	imRows.Close()
	if err := imRows.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}

	maps := []ControlPointMapObservation{}
	mRows, err := s.db.Query(r.Context(), `
		SELECT m.id, m.lat, m.lng, m.location_id, l.name
		FROM map_measurements m
		JOIN locations l ON l.id = m.location_id
		WHERE m.control_point_id = $1
		ORDER BY m.created_at`, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	for mRows.Next() {
		var o ControlPointMapObservation
		if err := mRows.Scan(&o.ID, &o.Lat, &o.Lng, &o.LocationID, &o.LocationName); err != nil {
			mRows.Close()
			writeErrorFromDB(w, err)
			return
		}
		maps = append(maps, o)
	}
	mRows.Close()
	if err := mRows.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}

	writeJSON(w, http.StatusOK, ControlPointObservations{
		ImageMeasurements: images,
		MapMeasurements:   maps,
	})
}

// controlPointsByLocation returns CPs referenced by any image or map measurement
// of this location. Cross-project CPs that aren't referenced from this project
// are excluded.
func (s *Server) controlPointsByLocation(ctx context.Context, locID string) ([]ControlPoint, error) {
	out := []ControlPoint{}
	rows, err := s.db.Query(ctx, `
		SELECT `+controlPointCols+`
		FROM control_points cp
		WHERE cp.id IN (
		  SELECT control_point_id FROM map_measurements
		  WHERE location_id = $1 AND control_point_id IS NOT NULL
		  UNION
		  SELECT im.control_point_id FROM image_measurements im
		  JOIN photos p ON p.id = im.photo_id
		  WHERE p.location_id = $1 AND im.control_point_id IS NOT NULL
		)
		ORDER BY cp.created_at`, locID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		cp, err := scanControlPoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, cp)
	}
	return out, rows.Err()
}
