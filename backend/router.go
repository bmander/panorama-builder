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

	mux.HandleFunc("POST /api/stations/{id}/photos", s.postPhoto)
	mux.HandleFunc("GET /api/photos/{id}", s.getPhoto)
	mux.HandleFunc("PUT /api/photos/{id}", s.putPhoto)
	mux.HandleFunc("DELETE /api/photos/{id}", s.deletePhoto)
	mux.HandleFunc("PUT /api/photos/{id}/blob", s.putPhotoBlob)
	mux.HandleFunc("GET /api/photos/{id}/blob", s.getPhotoBlob)

	mux.HandleFunc("POST /api/stations/{id}/map-measurements", s.postMapMeasurement)
	mux.HandleFunc("PUT /api/map-measurements/{id}", s.putMapMeasurement)
	mux.HandleFunc("DELETE /api/map-measurements/{id}", s.deleteMapMeasurement)

	mux.HandleFunc("POST /api/photos/{id}/image-measurements", s.postImageMeasurement)
	mux.HandleFunc("PUT /api/image-measurements/{id}", s.putImageMeasurement)
	mux.HandleFunc("DELETE /api/image-measurements/{id}", s.deleteImageMeasurement)

	mux.HandleFunc("POST /api/control-points", s.postControlPoint)
	mux.HandleFunc("GET /api/control-points", s.listControlPoints)
	mux.HandleFunc("GET /api/control-points/{id}", s.getControlPoint)
	mux.HandleFunc("PUT /api/control-points/{id}", s.putControlPoint)
	mux.HandleFunc("DELETE /api/control-points/{id}", s.deleteControlPoint)
	mux.HandleFunc("GET /api/control-points/{id}/observations", s.listControlPointObservations)

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
// serves index.html. This makes path-based routes like /<station-id> work
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
	full := filepath.Join(s.staticDir, clean)
	info, err := os.Stat(full)
	if err == nil && !info.IsDir() {
		http.ServeFile(w, r, full)
		return
	}
	// Control-point detail pages live at /cp/<id>; the page reads the id
	// from location.pathname at startup.
	if strings.HasPrefix(clean, "/cp/") {
		http.ServeFile(w, r, filepath.Join(s.staticDir, "cp.html"))
		return
	}
	// Fallback: SPA's index.
	http.ServeFile(w, r, filepath.Join(s.staticDir, "index.html"))
}
