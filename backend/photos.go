package main

import (
	"errors"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Column lists for the Photo row, kept in one place so the SELECT/RETURNING
// clauses and the matching scanPhoto helper can't drift apart.
const photoCols = `id, location_id, blob_path, mime_type, size_bytes, aspect,
		photo_az, photo_tilt, photo_roll, size_rad, opacity, created_at, updated_at`

func scanPhoto(row pgx.Row) (Photo, error) {
	var p Photo
	err := row.Scan(&p.ID, &p.LocationID, &p.BlobPath, &p.MimeType, &p.SizeBytes,
		&p.Aspect, &p.PhotoAz, &p.PhotoTilt, &p.PhotoRoll, &p.SizeRad, &p.Opacity,
		&p.CreatedAt, &p.UpdatedAt)
	return p, err
}

func (s *Server) postPhoto(w http.ResponseWriter, r *http.Request) {
	locID := requireID(w, r, "id")
	if locID == "" {
		return
	}
	var req PhotoPosePatch
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validatePhotoPosePatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	id := newID()
	opacity := 1.0
	if req.Opacity != nil {
		opacity = *req.Opacity
	}
	sizeRad := req.SizeRad
	if sizeRad == 0 {
		sizeRad = 0.5236 // ~30 degrees
	}
	q := `INSERT INTO photos (id, location_id, aspect, photo_az, photo_tilt, photo_roll, size_rad, opacity)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING ` + photoCols
	p, err := scanPhoto(s.db.QueryRow(r.Context(), q, id, locID, req.Aspect,
		req.PhotoAz, req.PhotoTilt, req.PhotoRoll, sizeRad, opacity))
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) getPhoto(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	q := `SELECT ` + photoCols + ` FROM photos WHERE id = $1`
	p, err := scanPhoto(s.db.QueryRow(r.Context(), q, id))
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) putPhoto(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req PhotoPosePatch
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validatePhotoPosePatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	opacity := 1.0
	if req.Opacity != nil {
		opacity = *req.Opacity
	}
	q := `UPDATE photos
		SET aspect=$2, photo_az=$3, photo_tilt=$4, photo_roll=$5, size_rad=$6, opacity=$7,
		    updated_at=NOW()
		WHERE id=$1
		RETURNING ` + photoCols
	p, err := scanPhoto(s.db.QueryRow(r.Context(), q, id, req.Aspect,
		req.PhotoAz, req.PhotoTilt, req.PhotoRoll, req.SizeRad, opacity))
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) deletePhoto(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM photos WHERE id = $1`, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	_ = s.blobs.deletePhoto(id)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) putPhotoBlob(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	mime := r.Header.Get("Content-Type")
	if !strings.HasPrefix(mime, "image/") {
		writeError(w, http.StatusBadRequest, "Content-Type must be image/*")
		return
	}
	// Confirm the photo row exists before we accept (and write) up to
	// maxBlobBytes of body to disk.
	var exists bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT EXISTS (SELECT 1 FROM photos WHERE id = $1)`, id,
	).Scan(&exists); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	n, path, err := s.blobs.writePhoto(id, r.Body, s.maxBlobBytes)
	if err != nil {
		if errors.Is(err, errPayloadTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "blob too large")
			return
		}
		log.Printf("write photo blob %s: %v", id, err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	_, err = s.db.Exec(r.Context(),
		`UPDATE photos SET blob_path=$2, mime_type=$3, size_bytes=$4, updated_at=NOW() WHERE id=$1`,
		id, path, mime, n)
	if err != nil {
		// Roll back the file write on DB failure.
		_ = s.blobs.deletePhoto(id)
		writeErrorFromDB(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getPhotoBlob(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var mime *string
	err := s.db.QueryRow(r.Context(),
		`SELECT mime_type FROM photos WHERE id = $1 AND blob_path IS NOT NULL`, id,
	).Scan(&mime)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	f, err := s.blobs.openPhoto(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "blob missing")
		return
	}
	defer f.Close()
	if mime != nil {
		w.Header().Set("Content-Type", *mime)
	}
	if _, err := io.Copy(w, f); err != nil {
		// Headers already sent; nothing useful to return.
		return
	}
}
