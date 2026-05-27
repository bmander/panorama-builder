package main

import (
	"net/http"

	"github.com/jackc/pgx/v5"
)

// Writes (POST/PUT/DELETE, including blob upload) require an open session
// and journal their effect there. Reads (GET) and the blob download stay
// session-agnostic; getPhoto applies the session overlay when a header is
// present.

const photoCols = `id, station_id, blob_path, mime_type, size_bytes, aspect,
		photo_az, photo_tilt, photo_roll, size_rad,
		lock_photo_az, lock_photo_tilt, lock_photo_roll, lock_size_rad,
		dist_k1, dist_k2, lock_dist_k1, lock_dist_k2,
		created_at, updated_at,
		sigma_photo_az, sigma_photo_tilt, sigma_photo_roll, sigma_size_rad,
		sigma_dist_k1, sigma_dist_k2`

func scanPhoto(row pgx.Row) (Photo, error) {
	var p Photo
	err := row.Scan(&p.ID, &p.StationID, &p.BlobPath, &p.MimeType, &p.SizeBytes,
		&p.Aspect, &p.PhotoAz, &p.PhotoTilt, &p.PhotoRoll, &p.SizeRad,
		&p.LockPhotoAz, &p.LockPhotoTilt, &p.LockPhotoRoll, &p.LockSizeRad,
		&p.DistK1, &p.DistK2, &p.LockDistK1, &p.LockDistK2,
		&p.CreatedAt, &p.UpdatedAt,
		&p.SigmaPhotoAz, &p.SigmaPhotoTilt, &p.SigmaPhotoRoll, &p.SigmaSizeRad,
		&p.SigmaDistK1, &p.SigmaDistK2)
	return p, err
}

func (s *Server) listPhotos(w http.ResponseWriter, r *http.Request) {
	if sess, ok := s.tryLoadSession(w, r); !ok {
		return
	} else if sess != nil {
		s.listPhotosInSession(w, r, sess)
		return
	}
	ctx := r.Context()
	photos, err := s.allPhotos(ctx)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	counts, err := s.observationCountsByPhoto(ctx)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, photosWithCounts(photos, counts))
}

func photosWithCounts(photos []Photo, counts map[string]int) []PhotoListItem {
	out := make([]PhotoListItem, len(photos))
	for i, p := range photos {
		out[i] = PhotoListItem{Photo: p, ObservationCount: counts[p.ID]}
	}
	return out
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

// getPhotoBlob resolves the row's blob_path (overlay-aware via X-Session-Id)
// and streams. Callers that already have the hash should hit /api/blobs/{hash}
// — content-addressed, immutable, no session lookup.
func (s *Server) getPhotoBlob(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	sess, ok := s.tryLoadSession(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	overlay := sessionOverlay{}
	if sess != nil {
		var err error
		if overlay, err = loadSessionOverlay(ctx, s.db, sess.ID); err != nil {
			writeErrorFromDB(w, err)
			return
		}
	}
	p, present, err := currentPhoto(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present || p.BlobPath == nil {
		writeError(w, http.StatusNotFound, "blob missing")
		return
	}
	f, err := s.blobs.openByPath(r.Context(), *p.BlobPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "blob missing")
		return
	}
	defer f.Close()
	if p.MimeType != nil {
		w.Header().Set("Content-Type", *p.MimeType)
	}
	// Row may repoint to new bytes on next re-upload+merge; never let
	// browsers cache the id-keyed URL.
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "", f.ModTime(), f)
}

// getBlob serves bytes content-addressed by sha256. Immutable forever.
func (s *Server) getBlob(w http.ResponseWriter, r *http.Request) {
	hash := r.PathValue("hash")
	f, err := s.blobs.openByHash(r.Context(), hash)
	if err != nil {
		writeError(w, http.StatusNotFound, "blob missing")
		return
	}
	defer f.Close()
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	// ServeContent will sniff Content-Type from the first 512 bytes when
	// the header isn't already set, and gives us range support + 304s.
	http.ServeContent(w, r, "", f.ModTime(), f)
}
