package main

import (
	"context"
	"errors"
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

// getPhotoBlob resolves the photo's stored blob_path (overlay-aware when
// X-Session-Id is present) and streams the bytes. Returns 404 when the row
// doesn't exist in the requested view, when blob_path is null, or when the
// referenced file is missing.
//
// Content-addressed blobs aren't derivable from photo id alone — callers
// that have the hash should prefer GET /api/blobs/{hash}, which serves the
// bytes directly with immutable cache headers.
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
	p, present, err := s.resolvePhotoForBlob(ctx, sess, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present || p.BlobPath == nil {
		writeError(w, http.StatusNotFound, "blob missing")
		return
	}
	f, err := s.blobs.openByPath(*p.BlobPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "blob missing")
		return
	}
	defer f.Close()
	if p.MimeType != nil {
		w.Header().Set("Content-Type", *p.MimeType)
	}
	if _, err := io.Copy(w, f); err != nil {
		return
	}
}

// resolvePhotoForBlob loads a photo via the session overlay when sess is
// non-nil, otherwise direct from main. Returns (zero, false, nil) when the
// row doesn't exist in the requested view.
func (s *Server) resolvePhotoForBlob(ctx context.Context, sess *Session, id string) (Photo, bool, error) {
	if sess != nil {
		overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
		if err != nil {
			return Photo{}, false, err
		}
		return currentPhoto(ctx, s.db, overlay, id)
	}
	p, err := scanPhoto(s.db.QueryRow(ctx,
		`SELECT `+photoCols+` FROM photos WHERE id = $1`, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Photo{}, false, nil
		}
		return Photo{}, false, err
	}
	return p, true, nil
}

// getBlob serves a content-addressed blob directly by its hash. The hash
// alone identifies immutable bytes, so the response carries far-future
// cache headers. mime_type isn't recorded per-blob, so Content-Type is
// sniffed from the first 512 bytes.
func (s *Server) getBlob(w http.ResponseWriter, r *http.Request) {
	hash := r.PathValue("hash")
	f, err := s.blobs.openByHash(hash)
	if err != nil {
		writeError(w, http.StatusNotFound, "blob missing")
		return
	}
	defer f.Close()
	var head [512]byte
	n, _ := io.ReadFull(f, head[:])
	w.Header().Set("Content-Type", http.DetectContentType(head[:n]))
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		writeError(w, http.StatusInternalServerError, "seek")
		return
	}
	if _, err := io.Copy(w, f); err != nil {
		return
	}
}
