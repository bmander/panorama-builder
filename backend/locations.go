package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// --- Domain shapes (also used by other handlers; kept here for the root) ---

type Location struct {
	ID        string    `json:"id"`
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Name      *string   `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Photo struct {
	ID         string    `json:"id"`
	LocationID string    `json:"location_id"`
	BlobPath   *string   `json:"blob_path,omitempty"`
	MimeType   *string   `json:"mime_type,omitempty"`
	SizeBytes  *int64    `json:"size_bytes,omitempty"`
	Aspect     float64   `json:"aspect"`
	PhotoAz    float64   `json:"photo_az"`
	PhotoTilt  float64   `json:"photo_tilt"`
	PhotoRoll  float64   `json:"photo_roll"`
	SizeRad    float64   `json:"size_rad"`
	Opacity    float64   `json:"opacity"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type MapPOI struct {
	ID         string    `json:"id"`
	LocationID string    `json:"location_id"`
	Lat        float64   `json:"lat"`
	Lng        float64   `json:"lng"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type ImagePOI struct {
	ID        string    `json:"id"`
	PhotoID   string    `json:"photo_id"`
	U         float64   `json:"u"`
	V         float64   `json:"v"`
	MapPOIID  *string   `json:"map_poi_id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// --- Handlers ---

type createLocationReq struct {
	Lat  float64 `json:"lat"`
	Lng  float64 `json:"lng"`
	Name *string `json:"name"`
}

func (s *Server) postLocation(w http.ResponseWriter, r *http.Request) {
	var req createLocationReq
	if !parseJSON(w, r, &req) {
		return
	}
	if !validLat(req.Lat) || !validLng(req.Lng) {
		writeError(w, http.StatusBadRequest, "lat/lng out of range")
		return
	}
	id := newID()
	const q = `INSERT INTO locations (id, lat, lng, name) VALUES ($1, $2, $3, $4)
	           RETURNING id, lat, lng, name, created_at, updated_at`
	var loc Location
	err := s.db.QueryRow(r.Context(), q, id, req.Lat, req.Lng, req.Name).Scan(
		&loc.ID, &loc.Lat, &loc.Lng, &loc.Name, &loc.CreatedAt, &loc.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, loc)
}

func (s *Server) listLocations(w http.ResponseWriter, r *http.Request) {
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
		sql = `SELECT id, lat, lng, name, created_at, updated_at FROM locations
		       WHERE ST_MakeEnvelope($1, $2, $3, $4, 4326)
		             && ST_SetSRID(ST_MakePoint(lng, lat), 4326)
		       ORDER BY created_at DESC LIMIT 1000`
		args = []any{v[0], v[1], v[2], v[3]}
	} else {
		sql = `SELECT id, lat, lng, name, created_at, updated_at FROM locations
		       ORDER BY created_at DESC LIMIT 1000`
	}
	cur, err := s.db.Query(r.Context(), sql, args...)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer cur.Close()
	out := []Location{}
	for cur.Next() {
		var loc Location
		if err := cur.Scan(&loc.ID, &loc.Lat, &loc.Lng, &loc.Name, &loc.CreatedAt, &loc.UpdatedAt); err != nil {
			writeErrorFromDB(w, err)
			return
		}
		out = append(out, loc)
	}
	if err := cur.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type hydratedLocation struct {
	Location  Location   `json:"location"`
	Photos    []Photo    `json:"photos"`
	MapPOIs   []MapPOI   `json:"map_pois"`
	ImagePOIs []ImagePOI `json:"image_pois"`
}

func (s *Server) getLocation(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	var loc Location
	err := s.db.QueryRow(ctx,
		`SELECT id, lat, lng, name, created_at, updated_at FROM locations WHERE id = $1`, id,
	).Scan(&loc.ID, &loc.Lat, &loc.Lng, &loc.Name, &loc.CreatedAt, &loc.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	photos, err := s.photosByLocation(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	mapPOIs, err := s.mapPOIsByLocation(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	imagePOIs, err := s.imagePOIsByLocation(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, hydratedLocation{loc, photos, mapPOIs, imagePOIs})
}

func (s *Server) putLocation(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req createLocationReq
	if !parseJSON(w, r, &req) {
		return
	}
	if !validLat(req.Lat) || !validLng(req.Lng) {
		writeError(w, http.StatusBadRequest, "lat/lng out of range")
		return
	}
	const q = `UPDATE locations SET lat=$2, lng=$3, name=$4, updated_at=NOW()
	           WHERE id=$1
	           RETURNING id, lat, lng, name, created_at, updated_at`
	var loc Location
	err := s.db.QueryRow(r.Context(), q, id, req.Lat, req.Lng, req.Name).Scan(
		&loc.ID, &loc.Lat, &loc.Lng, &loc.Name, &loc.CreatedAt, &loc.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, loc)
}

func (s *Server) deleteLocation(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	// Photos cascade to image POIs in the DB; we still need to remove blob
	// files from disk. Pull the photo IDs first, delete the row (cascades),
	// then unlink the files.
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `SELECT id FROM photos WHERE location_id = $1`, id)
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
	tag, err := s.db.Exec(ctx, `DELETE FROM locations WHERE id = $1`, id)
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

// --- Cascade-fetch helpers used by getLocation. Defined here because they
// belong with the hydrated read; they're also the only readers of these
// rows that filter by location_id. ---

func (s *Server) photosByLocation(ctx context.Context, locID string) ([]Photo, error) {
	out := []Photo{}
	rows, err := s.db.Query(ctx, `
		SELECT id, location_id, blob_path, mime_type, size_bytes, aspect,
		       photo_az, photo_tilt, photo_roll, size_rad, opacity,
		       created_at, updated_at
		FROM photos WHERE location_id = $1 ORDER BY created_at`, locID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p Photo
		if err := rows.Scan(&p.ID, &p.LocationID, &p.BlobPath, &p.MimeType, &p.SizeBytes,
			&p.Aspect, &p.PhotoAz, &p.PhotoTilt, &p.PhotoRoll, &p.SizeRad, &p.Opacity,
			&p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Server) mapPOIsByLocation(ctx context.Context, locID string) ([]MapPOI, error) {
	out := []MapPOI{}
	rows, err := s.db.Query(ctx, `
		SELECT id, location_id, lat, lng, created_at, updated_at
		FROM map_pois WHERE location_id = $1 ORDER BY created_at`, locID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m MapPOI
		if err := rows.Scan(&m.ID, &m.LocationID, &m.Lat, &m.Lng, &m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Server) imagePOIsByLocation(ctx context.Context, locID string) ([]ImagePOI, error) {
	out := []ImagePOI{}
	rows, err := s.db.Query(ctx, `
		SELECT i.id, i.photo_id, i.u, i.v, i.map_poi_id, i.created_at, i.updated_at
		FROM image_pois i
		JOIN photos p ON p.id = i.photo_id
		WHERE p.location_id = $1
		ORDER BY i.created_at`, locID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ip ImagePOI
		if err := rows.Scan(&ip.ID, &ip.PhotoID, &ip.U, &ip.V, &ip.MapPOIID, &ip.CreatedAt, &ip.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, ip)
	}
	return out, rows.Err()
}
