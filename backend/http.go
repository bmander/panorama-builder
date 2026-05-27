package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Centralized response writers. Keeps handlers terse and consistent.

// metadataBodyMax caps JSON request bodies for the (small) metadata endpoints.
// The blob-upload path uses Server.maxBlobBytes (much larger) instead.
const metadataBodyMax = 1 << 20 // 1 MiB

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	// Heuristic caching of un-headered JSON responses by browsers has bitten
	// us before (cp-page edits an entity, /world view then refetches and
	// gets the stale cached body). Mark every API response no-store.
	w.Header().Set("Cache-Control", "no-store")
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
	if err := decodeBody(w, r, dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

// decodeBody is the shared "small JSON request body" reader: it caps the
// body at metadataBodyMax and rejects unknown fields. Both parseJSON (typed
// destination) and parsePatch (raw map destination) go through it.
func decodeBody(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, metadataBodyMax)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
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

// requireSignOff trims the supplied value and rejects an empty result with
// 400 sign_off required. Used by every handler that creates a commit row.
func requireSignOff(w http.ResponseWriter, raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		writeError(w, http.StatusBadRequest, "sign_off required")
		return "", false
	}
	return s, true
}

func inRange(v, lo, hi float64) bool { return v >= lo && v <= hi }

func validLat(v float64) bool { return inRange(v, -90, 90) }
func validLng(v float64) bool { return inRange(v, -180, 180) }
func validUV(v float64) bool  { return inRange(v, 0, 1) }

// Body validators for the generated request types from types.gen.go. The
// spec at ../openapi.yaml documents the same constraints declaratively, but
// the generated types-only mode doesn't ship runtime validation; we keep
// these as the runtime gate.

func validateImageMeasurementPatch(req ImageMeasurementPatch) string {
	if !validUV(req.U) || !validUV(req.V) {
		return "u/v must be in [0, 1]"
	}
	if req.ControlPointID != nil && !validID(*req.ControlPointID) {
		return "invalid control_point_id"
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
	return ""
}

func validateControlPointPatch(req ControlPointPatch) string {
	if req.EstLat != nil && !validLat(*req.EstLat) {
		return "est_lat out of range"
	}
	if req.EstLng != nil && !validLng(*req.EstLng) {
		return "est_lng out of range"
	}
	return ""
}
