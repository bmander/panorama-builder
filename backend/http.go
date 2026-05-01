package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// Centralized response writers. Keeps handlers terse and consistent.

// metadataBodyMax caps JSON request bodies for the (small) metadata endpoints.
// The blob-upload path uses Server.maxBlobBytes (much larger) instead.
const metadataBodyMax = 1 << 20 // 1 MiB

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeErrorFromDB(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	log.Printf("db error: %v", err)
	writeError(w, http.StatusInternalServerError, "internal error")
}

func parseJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, metadataBodyMax)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

// requireID validates a path-param id; writes 400 and returns "" on failure.
func requireID(w http.ResponseWriter, r *http.Request, name string) string {
	id := r.PathValue(name)
	if !validID(id) {
		writeError(w, http.StatusBadRequest, "invalid "+name)
		return ""
	}
	return id
}

func inRange(v, lo, hi float64) bool { return v >= lo && v <= hi }

func validLat(v float64) bool { return inRange(v, -90, 90) }
func validLng(v float64) bool { return inRange(v, -180, 180) }
func validUV(v float64) bool  { return inRange(v, 0, 1) }

// Body validators for the generated request types from types.gen.go. The
// spec at ../openapi.yaml documents the same constraints declaratively, but
// the generated types-only mode doesn't ship runtime validation; we keep
// these as the runtime gate.

func validateMapPOIRequest(req MapPOIRequest) string {
	if !validLat(req.Lat) {
		return "lat out of range"
	}
	if !validLng(req.Lng) {
		return "lng out of range"
	}
	return ""
}

func validateImagePOIPatch(req ImagePOIPatch) string {
	if !validUV(req.U) || !validUV(req.V) {
		return "u/v must be in [0, 1]"
	}
	if req.MapPoiID != nil && !validID(*req.MapPoiID) {
		return "invalid map_poi_id"
	}
	return ""
}

func validatePhotoPosePatch(req PhotoPosePatch) string {
	if req.Aspect <= 0 || req.Aspect > 100 {
		return "aspect must be in (0, 100]"
	}
	if req.SizeRad < 0 {
		return "size_rad must be non-negative"
	}
	if req.Opacity != nil && !inRange(*req.Opacity, 0, 1) {
		return "opacity must be in [0, 1]"
	}
	return ""
}
