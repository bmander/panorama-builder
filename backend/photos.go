package main

import (
	"io"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// Writes (POST/PUT/DELETE, including blob upload) require an open session
// and journal their effect there. Reads (GET) and the blob download stay
// session-agnostic; getPhoto applies the session overlay when a header is
// present.

const photoCols = `id, station_id, blob_path, mime_type, size_bytes, aspect,
		photo_az, photo_tilt, photo_roll, size_rad, opacity,
		lock_photo_az, lock_photo_tilt, lock_photo_roll, lock_size_rad,
		dist_k1, dist_k2, lock_dist_k1, lock_dist_k2,
		created_at, updated_at`

func scanPhoto(row pgx.Row) (Photo, error) {
	var p Photo
	err := row.Scan(&p.ID, &p.StationID, &p.BlobPath, &p.MimeType, &p.SizeBytes,
		&p.Aspect, &p.PhotoAz, &p.PhotoTilt, &p.PhotoRoll, &p.SizeRad, &p.Opacity,
		&p.LockPhotoAz, &p.LockPhotoTilt, &p.LockPhotoRoll, &p.LockSizeRad,
		&p.DistK1, &p.DistK2, &p.LockDistK1, &p.LockDistK2,
		&p.CreatedAt, &p.UpdatedAt)
	return p, err
}

func (s *Server) postPhoto(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.postPhotoInSession(w, r, sess)
}

func (s *Server) getPhoto(w http.ResponseWriter, r *http.Request) {
	if sess, ok := s.tryLoadSession(w, r); !ok {
		return
	} else if sess != nil {
		s.getPhotoInSession(w, r, sess)
		return
	}
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
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.putPhotoInSession(w, r, sess)
}

func (s *Server) deletePhoto(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.deletePhotoInSession(w, r, sess)
}

func (s *Server) putPhotoBlob(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.putPhotoBlobInSession(w, r, sess)
}

func (s *Server) getPhotoBlob(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	// Blob lookup is by file existence rather than DB row: browsers fetch
	// this URL via <img> tags that don't carry our X-Session-Id header, so a
	// photo created in a session (whose row is only in session_ops) would
	// otherwise 404. The blob filename is the validated photo id.
	f, err := s.blobs.openPhoto(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "blob missing")
		return
	}
	defer f.Close()
	var mime *string
	_ = s.db.QueryRow(r.Context(),
		`SELECT mime_type FROM photos WHERE id = $1`, id,
	).Scan(&mime)
	if mime != nil {
		w.Header().Set("Content-Type", *mime)
	}
	if _, err := io.Copy(w, f); err != nil {
		return
	}
}
