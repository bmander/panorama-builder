package main

import (
	"context"
	"net/http"
	"time"
)

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.healthz)

	mux.HandleFunc("POST /locations", s.postLocation)
	mux.HandleFunc("GET /locations", s.listLocations)
	mux.HandleFunc("GET /locations/{id}", s.getLocation)
	mux.HandleFunc("PUT /locations/{id}", s.putLocation)
	mux.HandleFunc("DELETE /locations/{id}", s.deleteLocation)

	mux.HandleFunc("POST /locations/{id}/photos", s.postPhoto)
	mux.HandleFunc("GET /photos/{id}", s.getPhoto)
	mux.HandleFunc("PUT /photos/{id}", s.putPhoto)
	mux.HandleFunc("DELETE /photos/{id}", s.deletePhoto)
	mux.HandleFunc("PUT /photos/{id}/blob", s.putPhotoBlob)
	mux.HandleFunc("GET /photos/{id}/blob", s.getPhotoBlob)

	mux.HandleFunc("POST /locations/{id}/map-pois", s.postMapPOI)
	mux.HandleFunc("PUT /map-pois/{id}", s.putMapPOI)
	mux.HandleFunc("DELETE /map-pois/{id}", s.deleteMapPOI)

	mux.HandleFunc("POST /photos/{id}/image-pois", s.postImagePOI)
	mux.HandleFunc("PUT /image-pois/{id}", s.putImagePOI)
	mux.HandleFunc("DELETE /image-pois/{id}", s.deleteImagePOI)

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
