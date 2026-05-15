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
//
// Writes (POST/PUT/DELETE) require an open session — they journal an op
// rather than mutating main. Reads (GET) apply the session overlay when an
// X-Session-Id header is present; otherwise they return the main-only view.

const stationCols = `id, lat, lng, alt, name, lock_lat, lock_lng, lock_alt, captured_at, created_at, updated_at,
	sigma_lat, sigma_lng, sigma_alt`

func scanStation(row pgx.Row) (Station, error) {
	var st Station
	err := row.Scan(&st.ID, &st.Lat, &st.Lng, &st.Alt, &st.Name,
		&st.LockLat, &st.LockLng, &st.LockAlt, &st.CapturedAt, &st.CreatedAt, &st.UpdatedAt,
		&st.SigmaLat, &st.SigmaLng, &st.SigmaAlt)
	return st, err
}

func (s *Server) postStation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.postStationInSession(w, r, sess)
}

func (s *Server) listStations(w http.ResponseWriter, r *http.Request) {
	if sess, ok := s.tryLoadSession(w, r); !ok {
		return
	} else if sess != nil {
		s.listStationsInSession(w, r, sess)
		return
	}
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
	if sess, ok := s.tryLoadSession(w, r); !ok {
		return
	} else if sess != nil {
		s.getStationInSession(w, r, sess)
		return
	}
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
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.putStationInSession(w, r, sess)
}

func (s *Server) deleteStation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.deleteStationInSession(w, r, sess)
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
		im, err := scanImageMeasurement(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, im)
	}
	return out, rows.Err()
}
