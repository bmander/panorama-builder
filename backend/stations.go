package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Domain shapes (Station, Photo, ImageMeasurement, HydratedStation,
// CreateStationRequest, PhotoPosePatch, ImageMeasurementPatch) are
// generated from ../openapi.yaml into types.gen.go.

const stationCols = `id, lat, lng, alt, name, lock_lat, lock_lng, lock_alt, captured_at, created_at, updated_at`

func scanStation(row pgx.Row) (Station, error) {
	var st Station
	err := row.Scan(&st.ID, &st.Lat, &st.Lng, &st.Alt, &st.Name,
		&st.LockLat, &st.LockLng, &st.LockAlt, &st.CapturedAt, &st.CreatedAt, &st.UpdatedAt)
	return st, err
}

func (s *Server) postStation(w http.ResponseWriter, r *http.Request) {
	var req CreateStationRequest
	if !parseJSON(w, r, &req) {
		return
	}
	if !validLat(req.Lat) || !validLng(req.Lng) {
		writeError(w, http.StatusBadRequest, "lat/lng out of range")
		return
	}
	if req.CapturedAt.IsZero() {
		writeError(w, http.StatusBadRequest, "captured_at is required")
		return
	}
	id := newID()
	const q = `INSERT INTO stations (id, lat, lng, alt, name, lock_lat, lock_lng, lock_alt, captured_at)
	           VALUES ($1, $2, $3, COALESCE($4, 0), $5,
	                   COALESCE($6, false), COALESCE($7, false), COALESCE($8, false), $9)
	           RETURNING ` + stationCols
	st, err := scanStation(s.db.QueryRow(r.Context(), q, id, req.Lat, req.Lng, req.Alt, req.Name,
		req.LockLat, req.LockLng, req.LockAlt, req.CapturedAt))
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, st)
}

func (s *Server) listStations(w http.ResponseWriter, r *http.Request) {
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
		sql = `SELECT ` + stationCols + ` FROM stations
		       WHERE ST_MakeEnvelope($1, $2, $3, $4, 4326)
		             && ST_SetSRID(ST_MakePoint(lng, lat), 4326)
		       ORDER BY created_at DESC LIMIT 1000`
		args = []any{v[0], v[1], v[2], v[3]}
	} else {
		sql = `SELECT ` + stationCols + ` FROM stations
		       ORDER BY created_at DESC LIMIT 1000`
	}
	cur, err := s.db.Query(r.Context(), sql, args...)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer cur.Close()
	out := []Station{}
	for cur.Next() {
		st, err := scanStation(cur)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		out = append(out, st)
	}
	if err := cur.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) getStation(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	st, err := scanStation(s.db.QueryRow(ctx,
		`SELECT `+stationCols+` FROM stations WHERE id = $1`, id))
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	photos, err := s.photosByStation(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	imageMeasurements, err := s.imageMeasurementsByStation(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	controlPoints, err := s.controlPointsByStation(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, HydratedStation{
		Station:           st,
		Photos:            photos,
		ImageMeasurements: imageMeasurements,
		ControlPoints:     controlPoints,
	})
}

func (s *Server) putStation(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	patch, ok := parsePatch(w, r)
	if !ok {
		return
	}
	b := newUpdateBuilder(id)
	if v, present, err := patch.Float64("lat"); present {
		if err != nil || !validLat(v) {
			writeError(w, http.StatusBadRequest, "lat out of range")
			return
		}
		b.Set("lat", v)
	}
	if v, present, err := patch.Float64("lng"); present {
		if err != nil || !validLng(v) {
			writeError(w, http.StatusBadRequest, "lng out of range")
			return
		}
		b.Set("lng", v)
	}
	if v, present, err := patch.Float64("alt"); present {
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		b.Set("alt", v)
	}
	if v, present, err := patch.NullableString("name"); present {
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		b.Set("name", v)
	}
	for _, key := range []string{"lock_lat", "lock_lng", "lock_alt"} {
		if v, present, err := patch.Bool(key); present {
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			b.Set(key, v)
		}
	}
	if v, present, err := patch.NullableTime("captured_at"); present {
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if v == nil {
			writeError(w, http.StatusBadRequest, "captured_at must not be null")
			return
		}
		b.Set("captured_at", v)
	}
	if b.Empty() {
		writeError(w, http.StatusBadRequest, "no updatable fields")
		return
	}
	st, err := scanStation(s.db.QueryRow(r.Context(), b.Query("stations", stationCols), b.Args()...))
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) deleteStation(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	// Photos cascade to image measurements in the DB; we still need to remove
	// blob files from disk. Pull the photo IDs first, delete the row
	// (cascades), then unlink the files.
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `SELECT id FROM photos WHERE station_id = $1`, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	var photoIDs []string
	for rows.Next() {
		var pid string
		if err := rows.Scan(&pid); err != nil {
			rows.Close()
			writeErrorFromDB(w, err)
			return
		}
		photoIDs = append(photoIDs, pid)
	}
	rows.Close()
	tag, err := s.db.Exec(ctx, `DELETE FROM stations WHERE id = $1`, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	for _, pid := range photoIDs {
		_ = s.blobs.deletePhoto(pid)
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Cascade-fetch helpers used by getStation. Defined here because they
// belong with the hydrated read; they're also the only readers of these
// rows that filter by station_id. ---

func (s *Server) photosByStation(ctx context.Context, stationID string) ([]Photo, error) {
	out := []Photo{}
	rows, err := s.db.Query(ctx,
		`SELECT `+photoCols+` FROM photos WHERE station_id = $1 ORDER BY created_at`, stationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		p, err := scanPhoto(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Server) imageMeasurementsByStation(ctx context.Context, stationID string) ([]ImageMeasurement, error) {
	out := []ImageMeasurement{}
	rows, err := s.db.Query(ctx, `
		SELECT i.id, i.photo_id, i.u, i.v, i.control_point_id, i.created_at, i.updated_at
		FROM image_measurements i
		JOIN photos p ON p.id = i.photo_id
		WHERE p.station_id = $1
		ORDER BY i.created_at`, stationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var im ImageMeasurement
		if err := rows.Scan(&im.ID, &im.PhotoID, &im.U, &im.V, &im.ControlPointID, &im.CreatedAt, &im.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, im)
	}
	return out, rows.Err()
}
