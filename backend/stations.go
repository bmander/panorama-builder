package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"
)

// Domain shapes (Station, Photo, MapMeasurement, ImageMeasurement,
// HydratedStation, CreateStationRequest, MapMeasurementRequest,
// PhotoPosePatch, ImageMeasurementPatch) are generated from
// ../openapi.yaml into types.gen.go.

func (s *Server) postStation(w http.ResponseWriter, r *http.Request) {
	var req CreateStationRequest
	if !parseJSON(w, r, &req) {
		return
	}
	if !validLat(req.Lat) || !validLng(req.Lng) {
		writeError(w, http.StatusBadRequest, "lat/lng out of range")
		return
	}
	id := newID()
	const q = `INSERT INTO stations (id, lat, lng, name) VALUES ($1, $2, $3, $4)
	           RETURNING id, lat, lng, name, created_at, updated_at`
	var st Station
	err := s.db.QueryRow(r.Context(), q, id, req.Lat, req.Lng, req.Name).Scan(
		&st.ID, &st.Lat, &st.Lng, &st.Name, &st.CreatedAt, &st.UpdatedAt)
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
		sql = `SELECT id, lat, lng, name, created_at, updated_at FROM stations
		       WHERE ST_MakeEnvelope($1, $2, $3, $4, 4326)
		             && ST_SetSRID(ST_MakePoint(lng, lat), 4326)
		       ORDER BY created_at DESC LIMIT 1000`
		args = []any{v[0], v[1], v[2], v[3]}
	} else {
		sql = `SELECT id, lat, lng, name, created_at, updated_at FROM stations
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
		var st Station
		if err := cur.Scan(&st.ID, &st.Lat, &st.Lng, &st.Name, &st.CreatedAt, &st.UpdatedAt); err != nil {
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
	var st Station
	err := s.db.QueryRow(ctx,
		`SELECT id, lat, lng, name, created_at, updated_at FROM stations WHERE id = $1`, id,
	).Scan(&st.ID, &st.Lat, &st.Lng, &st.Name, &st.CreatedAt, &st.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	photos, err := s.photosByStation(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	mapMeasurements, err := s.mapMeasurementsByStation(ctx, id)
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
		MapMeasurements:   mapMeasurements,
		ImageMeasurements: imageMeasurements,
		ControlPoints:     controlPoints,
	})
}

func (s *Server) putStation(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req CreateStationRequest
	if !parseJSON(w, r, &req) {
		return
	}
	if !validLat(req.Lat) || !validLng(req.Lng) {
		writeError(w, http.StatusBadRequest, "lat/lng out of range")
		return
	}
	const q = `UPDATE stations SET lat=$2, lng=$3, name=$4, updated_at=NOW()
	           WHERE id=$1
	           RETURNING id, lat, lng, name, created_at, updated_at`
	var st Station
	err := s.db.QueryRow(r.Context(), q, id, req.Lat, req.Lng, req.Name).Scan(
		&st.ID, &st.Lat, &st.Lng, &st.Name, &st.CreatedAt, &st.UpdatedAt)
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
	rows, err := s.db.Query(ctx, `
		SELECT id, station_id, blob_path, mime_type, size_bytes, aspect,
		       photo_az, photo_tilt, photo_roll, size_rad, opacity,
		       created_at, updated_at
		FROM photos WHERE station_id = $1 ORDER BY created_at`, stationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p Photo
		if err := rows.Scan(&p.ID, &p.StationID, &p.BlobPath, &p.MimeType, &p.SizeBytes,
			&p.Aspect, &p.PhotoAz, &p.PhotoTilt, &p.PhotoRoll, &p.SizeRad, &p.Opacity,
			&p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Server) mapMeasurementsByStation(ctx context.Context, stationID string) ([]MapMeasurement, error) {
	out := []MapMeasurement{}
	rows, err := s.db.Query(ctx, `
		SELECT `+mapMeasurementCols+`
		FROM map_measurements WHERE station_id = $1 ORDER BY created_at`, stationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m MapMeasurement
		if err := rows.Scan(&m.ID, &m.StationID, &m.Lat, &m.Lng, &m.ControlPointID, &m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
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
