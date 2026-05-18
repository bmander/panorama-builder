package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

const controlPointCols = `id, description, notes, est_lat, est_lng, est_alt, started_at, ended_at,
	lock_est_lat, lock_est_lng, lock_est_alt, created_at, updated_at,
	sigma_est_lat, sigma_est_lng, sigma_est_alt, cov_est_lat_lng,
	started_at_lower, started_at_upper, ended_at_lower, ended_at_upper,
	derivation_inconsistent`

func scanControlPoint(row pgx.Row) (ControlPoint, error) {
	var cp ControlPoint
	err := row.Scan(&cp.ID, &cp.Description, &cp.Notes, &cp.EstLat, &cp.EstLng, &cp.EstAlt,
		&cp.StartedAt, &cp.EndedAt,
		&cp.LockEstLat, &cp.LockEstLng, &cp.LockEstAlt,
		&cp.CreatedAt, &cp.UpdatedAt,
		&cp.SigmaEstLat, &cp.SigmaEstLng, &cp.SigmaEstAlt, &cp.CovEstLatLng,
		&cp.DerivedWindow.StartedAtLower, &cp.DerivedWindow.StartedAtUpper,
		&cp.DerivedWindow.EndedAtLower, &cp.DerivedWindow.EndedAtUpper,
		&cp.DerivedWindow.Inconsistent)
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
	if sess, ok := s.tryLoadSession(w, r); !ok {
		return
	} else if sess != nil {
		s.listControlPointsInSession(w, r, sess)
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
	if sess, ok := s.tryLoadSession(w, r); !ok {
		return
	} else if sess != nil {
		s.listControlPointObservationsInSession(w, r, sess)
		return
	}
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
		       st.captured_at_lower, st.captured_at_upper, st.derivation_inconsistent,
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
			&o.StationDerivedWindow.CapturedAtLower, &o.StationDerivedWindow.CapturedAtUpper,
			&o.StationDerivedWindow.Inconsistent,
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
	if sess, ok := s.tryLoadSession(w, r); !ok {
		return
	} else if sess != nil {
		s.listControlPointVisiblePhotosInSession(w, r, sess)
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
	out := ControlPointVisiblePhotos{Photos: []ControlPointVisiblePhoto{}}
	if cp.EstLat == nil || cp.EstLng == nil {
		writeJSON(w, http.StatusOK, out)
		return
	}

	// "Possibly extant at the station's capture time" — cp.derived_window
	// already folds in precise dates, so we filter against the materialized
	// columns. Stations with NULL captured_at pass the temporal gate (no
	// evidence either way).
	where := []string{
		"p.id NOT IN (SELECT photo_id FROM image_measurements WHERE control_point_id = $1)",
	}
	args := []any{id}
	if cp.DerivedWindow.StartedAtLower != nil {
		args = append(args, *cp.DerivedWindow.StartedAtLower)
		where = append(where, fmt.Sprintf("(st.captured_at IS NULL OR st.captured_at >= $%d)", len(args)))
	}
	if cp.DerivedWindow.EndedAtUpper != nil {
		args = append(args, *cp.DerivedWindow.EndedAtUpper)
		where = append(where, fmt.Sprintf("(st.captured_at IS NULL OR st.captured_at <= $%d)", len(args)))
	}
	sql := `
		SELECT p.id, p.station_id, st.name, st.captured_at,
		       st.captured_at_lower, st.captured_at_upper, st.derivation_inconsistent,
		       st.lat, st.lng, p.photo_az, p.size_rad
		FROM photos p
		JOIN stations st ON st.id = p.station_id
		WHERE ` + strings.Join(where, " AND ")
	rows, err := s.db.Query(r.Context(), sql, args...)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer rows.Close()
	var withDist []visiblePhotoWithDist
	for rows.Next() {
		var p ControlPointVisiblePhoto
		var stationLat, stationLng, photoAz, sizeRad float64
		if err := rows.Scan(
			&p.PhotoID, &p.StationID, &p.StationName, &p.StationCapturedAt,
			&p.StationDerivedWindow.CapturedAtLower, &p.StationDerivedWindow.CapturedAtUpper,
			&p.StationDerivedWindow.Inconsistent,
			&stationLat, &stationLng, &photoAz, &sizeRad,
		); err != nil {
			writeErrorFromDB(w, err)
			return
		}
		if !inHorizontalViewshed(stationLat, stationLng, *cp.EstLat, *cp.EstLng, photoAz, sizeRad) {
			continue
		}
		withDist = append(withDist, visiblePhotoWithDist{
			photo: p,
			distM: equirectDistMeters(stationLat, stationLng, *cp.EstLat, *cp.EstLng),
		})
	}
	if err := rows.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	out.Photos = sortVisiblePhotosByDist(withDist)
	writeJSON(w, http.StatusOK, out)
}

// getControlPointInconsistencyReasons returns the list of contradicting
// constraints involving this CP under the current bounds. Honors
// X-Session-Id so the answer matches what the user sees in the page.
func (s *Server) getControlPointInconsistencyReasons(w http.ResponseWriter, r *http.Request) {
	s.respondInconsistencyReasons(w, r, explainControlPointInconsistency)
}

type visiblePhotoWithDist struct {
	photo ControlPointVisiblePhoto
	distM float64
}

func sortVisiblePhotosByDist(withDist []visiblePhotoWithDist) []ControlPointVisiblePhoto {
	sort.Slice(withDist, func(i, j int) bool {
		if withDist[i].distM != withDist[j].distM {
			return withDist[i].distM < withDist[j].distM
		}
		return withDist[i].photo.PhotoID < withDist[j].photo.PhotoID
	})
	out := make([]ControlPointVisiblePhoto, len(withDist))
	for i, w := range withDist {
		w.photo.DistanceM = w.distM
		out[i] = w.photo
	}
	return out
}

// imageMeasurementsByControlPoint returns rows in main that currently
// reference this CP. Used as the base set for the in-session observations
// and visible-photos endpoints; the overlay is layered on top.
func (s *Server) imageMeasurementsByControlPoint(ctx context.Context, cpID string) ([]ImageMeasurement, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+imageMeasurementCols+` FROM image_measurements WHERE control_point_id=$1 ORDER BY created_at`,
		cpID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ImageMeasurement{}
	for rows.Next() {
		im, err := scanImageMeasurement(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, im)
	}
	return out, rows.Err()
}

// observationCountsByPhoto returns, for every photo with at least one
// image measurement, the count of measurements anchored on that photo.
// Reads from main only; in-session inserts/deletes are not reflected.
func (s *Server) observationCountsByPhoto(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.Query(ctx,
		`SELECT photo_id, COUNT(*) FROM image_measurements GROUP BY photo_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// allPhotos returns every photo row from main. The visible-photos endpoint
// needs the full set so the overlay can append session-only inserts.
func (s *Server) allPhotos(ctx context.Context) ([]Photo, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+photoCols+` FROM photos ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Photo{}
	for rows.Next() {
		p, err := scanPhoto(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// controlPointsByStationOrObserved returns CPs referenced by any image
// measurement on this station's photos *or* by a cp_observation row at
// this station — so the frontend can show observation status for CPs that
// don't yet have a pixel pin (e.g. missing or cant_see).
func (s *Server) controlPointsByStationOrObserved(ctx context.Context, stationID string) ([]ControlPoint, error) {
	out := []ControlPoint{}
	rows, err := s.db.Query(ctx, `
		SELECT `+controlPointCols+`
		FROM control_points cp
		WHERE cp.id IN (
		  SELECT im.control_point_id FROM image_measurements im
		  JOIN photos p ON p.id = im.photo_id
		  WHERE p.station_id = $1 AND im.control_point_id IS NOT NULL
		  UNION
		  SELECT control_point_id FROM cp_observations WHERE station_id = $1
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
