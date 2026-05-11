package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

const controlPointCols = `id, description, notes, est_lat, est_lng, est_alt, started_at, ended_at,
	started_after, ended_before,
	lock_est_lat, lock_est_lng, lock_est_alt, created_at, updated_at`

func scanControlPoint(row pgx.Row) (ControlPoint, error) {
	var cp ControlPoint
	err := row.Scan(&cp.ID, &cp.Description, &cp.Notes, &cp.EstLat, &cp.EstLng, &cp.EstAlt,
		&cp.StartedAt, &cp.EndedAt,
		&cp.StartedAfter, &cp.EndedBefore,
		&cp.LockEstLat, &cp.LockEstLng, &cp.LockEstAlt,
		&cp.CreatedAt, &cp.UpdatedAt)
	return cp, err
}

func (s *Server) postControlPoint(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.postControlPointInSession(w, r, sess)
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
	if sess, ok := s.tryLoadSession(w, r); !ok {
		return
	} else if sess != nil {
		s.getControlPointInSession(w, r, sess)
		return
	}
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
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.putControlPointInSession(w, r, sess)
}

func (s *Server) deleteControlPoint(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.deleteControlPointInSession(w, r, sess)
}

func (s *Server) listControlPointObservations(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	// Distinguish "no observations" from "no such CP" — empty payload would
	// otherwise be ambiguous.
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
		SELECT im.id, im.photo_id, im.u, im.v,
		       p.station_id, st.name, st.lat, st.lng,
		       st.captured_at,
		       p.photo_az, p.photo_tilt, p.photo_roll, p.size_rad, p.aspect
		FROM image_measurements im
		JOIN photos p    ON p.id = im.photo_id
		JOIN stations st ON st.id = p.station_id
		WHERE im.control_point_id = $1
		ORDER BY st.captured_at, im.created_at`, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer imRows.Close()
	for imRows.Next() {
		var o ControlPointImageObservation
		if err := imRows.Scan(
			&o.ID, &o.PhotoID, &o.U, &o.V,
			&o.StationID, &o.StationName, &o.StationLat, &o.StationLng,
			&o.StationCapturedAt,
			&o.PhotoAz, &o.PhotoTilt, &o.PhotoRoll, &o.SizeRad, &o.Aspect,
		); err != nil {
			writeErrorFromDB(w, err)
			return
		}
		images = append(images, o)
	}
	if err := imRows.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}

	writeJSON(w, http.StatusOK, ControlPointObservations{
		ImageMeasurements: images,
	})
}

// listControlPointVisiblePhotos returns photos whose horizontal viewshed
// contains this CP's estimated location, whose station capture time falls
// inside the CP's lifespan, and which don't already have an image
// measurement for this CP.
func (s *Server) listControlPointVisiblePhotos(w http.ResponseWriter, r *http.Request) {
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
	out := ControlPointVisiblePhotos{Photos: []ControlPointVisiblePhoto{}}
	if cp.EstLat == nil || cp.EstLng == nil {
		writeJSON(w, http.StatusOK, out)
		return
	}

	where := []string{
		"p.id NOT IN (SELECT photo_id FROM image_measurements WHERE control_point_id = $1)",
	}
	args := []any{id}
	if cp.StartedAt != nil {
		op := ">="
		if cp.StartedAfter {
			op = ">"
		}
		args = append(args, *cp.StartedAt)
		where = append(where, fmt.Sprintf("st.captured_at %s $%d", op, len(args)))
	}
	if cp.EndedAt != nil {
		op := "<="
		if cp.EndedBefore {
			op = "<"
		}
		args = append(args, *cp.EndedAt)
		where = append(where, fmt.Sprintf("st.captured_at %s $%d", op, len(args)))
	}
	sql := `
		SELECT p.id, p.station_id, st.name, st.captured_at,
		       st.lat, st.lng, p.photo_az, p.size_rad
		FROM photos p
		JOIN stations st ON st.id = p.station_id
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY st.captured_at, p.id`
	rows, err := s.db.Query(r.Context(), sql, args...)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var p ControlPointVisiblePhoto
		var stationLat, stationLng, photoAz, sizeRad float64
		if err := rows.Scan(
			&p.PhotoID, &p.StationID, &p.StationName, &p.StationCapturedAt,
			&stationLat, &stationLng, &photoAz, &sizeRad,
		); err != nil {
			writeErrorFromDB(w, err)
			return
		}
		if !inHorizontalViewshed(stationLat, stationLng, *cp.EstLat, *cp.EstLng, photoAz, sizeRad) {
			continue
		}
		out.Photos = append(out.Photos, p)
	}
	if err := rows.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// controlPointsByStation returns CPs referenced by any image measurement on
// this station's photos.
func (s *Server) controlPointsByStation(ctx context.Context, stationID string) ([]ControlPoint, error) {
	out := []ControlPoint{}
	rows, err := s.db.Query(ctx, `
		SELECT `+controlPointCols+`
		FROM control_points cp
		WHERE cp.id IN (
		  SELECT im.control_point_id FROM image_measurements im
		  JOIN photos p ON p.id = im.photo_id
		  WHERE p.station_id = $1 AND im.control_point_id IS NOT NULL
		)
		ORDER BY cp.created_at`, stationID)
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
