package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/healthz", s.healthz)

	mux.HandleFunc("POST /api/stations", s.postStation)
	mux.HandleFunc("GET /api/stations", s.listStations)
	mux.HandleFunc("GET /api/stations/{id}", s.getStation)
	mux.HandleFunc("PUT /api/stations/{id}", s.putStation)
	mux.HandleFunc("DELETE /api/stations/{id}", s.deleteStation)
	mux.HandleFunc("GET /api/stations/{id}/inconsistency-reasons", s.getStationInconsistencyReasons)

	mux.HandleFunc("POST /api/stations/{id}/photos", s.postPhoto)
	mux.HandleFunc("GET /api/photos", s.listPhotos)
	mux.HandleFunc("GET /api/photos/{id}", s.getPhoto)
	mux.HandleFunc("PUT /api/photos/{id}", s.putPhoto)
	mux.HandleFunc("DELETE /api/photos/{id}", s.deletePhoto)
	mux.HandleFunc("PUT /api/photos/{id}/blob", s.putPhotoBlob)
	mux.HandleFunc("GET /api/photos/{id}/blob", s.getPhotoBlob)
	mux.HandleFunc("GET /api/blobs/{hash}", s.getBlob)
	mux.HandleFunc("GET /api/blobs/{hash}/preview", s.getBlobPreview)

	mux.HandleFunc("POST /api/photos/{id}/image-measurements", s.postImageMeasurement)
	mux.HandleFunc("PUT /api/image-measurements/{id}", s.putImageMeasurement)
	mux.HandleFunc("DELETE /api/image-measurements/{id}", s.deleteImageMeasurement)

	mux.HandleFunc("POST /api/solve/joint", s.postSolveJoint)
	mux.HandleFunc("POST /api/solve/joint/stream", s.postSolveJointStream)
	mux.HandleFunc("POST /api/solve/stop", s.postSolveStop)
	mux.HandleFunc("POST /api/solve/stations/{id}", s.postSolveStation)
	mux.HandleFunc("POST /api/solve/stations/{id}/stream", s.postSolveStationStream)
	mux.HandleFunc("POST /api/solve/control-points/{id}", s.postSolveControlPoint)

	mux.HandleFunc("POST /api/control-points", s.postControlPoint)
	mux.HandleFunc("GET /api/control-points", s.listControlPoints)
	mux.HandleFunc("GET /api/control-points/{id}", s.getControlPoint)
	mux.HandleFunc("PUT /api/control-points/{id}", s.putControlPoint)
	mux.HandleFunc("DELETE /api/control-points/{id}", s.deleteControlPoint)
	mux.HandleFunc("GET /api/control-points/{id}/observations", s.listControlPointObservations)
	mux.HandleFunc("GET /api/control-points/{id}/visible-photos", s.listControlPointVisiblePhotos)
	mux.HandleFunc("GET /api/control-points/{id}/cp-observations", s.listCpObservationsByControlPoint)
	mux.HandleFunc("GET /api/control-points/{id}/inconsistency-reasons", s.getControlPointInconsistencyReasons)
	mux.HandleFunc("GET /api/control-point-fits", s.listControlPointFits)

	mux.HandleFunc("POST /api/stations/{id}/cp-observations", s.postCpObservation)
	mux.HandleFunc("PUT /api/cp-observations/{id}", s.putCpObservation)
	mux.HandleFunc("DELETE /api/cp-observations/{id}", s.deleteCpObservation)

	mux.HandleFunc("POST /api/control-point-constraints", s.postCPConstraint)
	mux.HandleFunc("GET /api/control-point-constraints", s.listCPConstraints)
	mux.HandleFunc("PUT /api/control-point-constraints/{id}", s.putCPConstraint)
	mux.HandleFunc("DELETE /api/control-point-constraints/{id}", s.deleteCPConstraint)

	mux.HandleFunc("POST /api/control-point-surfaces", s.postCPSurface)
	mux.HandleFunc("GET /api/control-point-surfaces", s.listCPSurfaces)
	mux.HandleFunc("DELETE /api/control-point-surfaces/{id}", s.deleteCPSurface)

	mux.HandleFunc("POST /api/sessions", s.postSession)
	mux.HandleFunc("GET /api/sessions/{id}", s.getSession)
	mux.HandleFunc("GET /api/sessions/{id}/ops", s.getSessionOps)
	mux.HandleFunc("GET /api/sessions/{id}/rank-deficient", s.getSessionRankDeficient)
	mux.HandleFunc("POST /api/sessions/{id}/abandon", s.abandonSession)
	mux.HandleFunc("POST /api/sessions/{id}/merge", s.mergeSession)

	mux.HandleFunc("GET /api/commits", s.listCommits)
	mux.HandleFunc("GET /api/commits/{id}", s.getCommit)
	mux.HandleFunc("POST /api/commits/{id}/revert", s.revertCommit)
	mux.HandleFunc("POST /api/commits/{id}/revert_to_before", s.revertToBefore)

	// Catch-all: serve static frontend with SPA fallback for unknown paths.
	mux.HandleFunc("/", s.spaFallback)

	return cors(s.allowedOrigin, mux)
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "db ping failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// spaFallback serves a static file if it exists under STATIC_DIR; otherwise
// serves index.html. This makes path-based routes like /station/<id> work
// on hard refresh — the SPA reads location.pathname at startup.
//
// Only GET (and HEAD) requests are served; everything else falls through
// to a 405. /api/* is matched by more-specific routes above and never
// reaches this handler.
func (s *Server) spaFallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	clean := filepath.Clean(r.URL.Path)
	// filepath.Clean turns "/" into "/" but also resolves ".." escapes.
	// We additionally reject any path that tries to climb above the root.
	if strings.HasPrefix(clean, "..") {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	// HTML responses always revalidate. Without this, a browser that cached
	// an older route's response (e.g. the SPA fallback before /stations had
	// its own page) keeps replaying the stale HTML until the heuristic TTL
	// expires. Static assets keep their normal Last-Modified caching.
	serveHTML := func(filename string) {
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(s.staticDir, filename))
	}
	full := filepath.Join(s.staticDir, clean)
	info, err := os.Stat(full)
	if err == nil && !info.IsDir() {
		if strings.HasSuffix(clean, ".html") {
			w.Header().Set("Cache-Control", "no-cache")
		}
		http.ServeFile(w, r, full)
		return
	}
	// Control-point listing lives at /cp; detail pages at /cp/<id>. The
	// detail page reads the id from location.pathname at startup.
	if clean == "/cp" || clean == "/cp/" {
		serveHTML("cp-index.html")
		return
	}
	if strings.HasPrefix(clean, "/cp/") {
		serveHTML("cp.html")
		return
	}
	if clean == "/stations" || clean == "/stations/" {
		serveHTML("stations-index.html")
		return
	}
	if clean == "/photos" || clean == "/photos/" {
		serveHTML("photos-index.html")
		return
	}
	if clean == "/history" || clean == "/history/" {
		serveHTML("history.html")
		return
	}
	// Fallback: SPA's index.
	serveHTML("index.html")
}
