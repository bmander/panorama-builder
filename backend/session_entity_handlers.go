package main

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
)

// session_entity_handlers.go: when X-Session-Id is present and resolves to
// an open session, the existing entity write handlers dispatch into the
// *InSession variants below. Each one journals an op to session_ops instead
// of touching the main tables.
//
// Reads ("get*InSession") apply the session overlay so the user sees their
// own pending edits.

// --- Stations ---

func (s *Server) postStationInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	var req CreateStationRequest
	if !parseJSON(w, r, &req) {
		return
	}
	if !validLat(req.Lat) || !validLng(req.Lng) {
		writeError(w, http.StatusBadRequest, "lat/lng out of range")
		return
	}
	id := newID()
	now := time.Now().UTC()
	st := Station{
		ID: id, Lat: req.Lat, Lng: req.Lng,
		CapturedAt: req.CapturedAt,
		CreatedAt:  now, UpdatedAt: now,
	}
	if req.Alt != nil {
		st.Alt = *req.Alt
	}
	if req.Name != nil {
		st.Name = req.Name
	}
	if req.LockLat != nil {
		st.LockLat = *req.LockLat
	}
	if req.LockLng != nil {
		st.LockLng = *req.LockLng
	}
	if req.LockAlt != nil {
		st.LockAlt = *req.LockAlt
	}
	if err := s.recordOpDirect(r.Context(), sess.ID, entityStation, id, "insert", nil, jsonMust(st)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, st)
}

func (s *Server) putStationInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	patch, ok := parsePatch(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentStation(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	before := jsonMust(cur)
	if err := applyStationPatch(&cur, patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	cur.UpdatedAt = time.Now().UTC()
	if err := s.recordOpDirect(ctx, sess.ID, entityStation, id, "update", before, jsonMust(cur)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cur)
}

func (s *Server) deleteStationInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	st, present, err := currentStation(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	// Cascade: every dependent must be journaled so revert restores it.
	// FKs are RESTRICT (migration 0024) so forgetting a dependent fails
	// loudly at merge.
	photos, err := s.collectPhotosForCascade(ctx, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cpObs, err := s.collectCpObservationsForStation(ctx, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, o := range cpObs {
		if err := recordOp(ctx, tx, sess.ID, entityCPObservation, o.ID, "delete", jsonMust(o), nil); err != nil {
			writeErrorFromDB(w, err)
			return
		}
	}
	for _, p := range photos {
		ims, err := s.collectImageMeasurementsForPhoto(ctx, overlay, p.ID)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		for _, im := range ims {
			if err := recordOp(ctx, tx, sess.ID, entityImageMeasurement, im.ID, "delete", jsonMust(im), nil); err != nil {
				writeErrorFromDB(w, err)
				return
			}
		}
		if err := recordOp(ctx, tx, sess.ID, entityPhoto, p.ID, "delete", jsonMust(p), nil); err != nil {
			writeErrorFromDB(w, err)
			return
		}
	}
	if err := recordOp(ctx, tx, sess.ID, entityStation, id, "delete", jsonMust(st), nil); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if err := runPropagationInTx(ctx, tx, sess.ID); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// getStationInSession is the overlay-aware hydrated read.
func (s *Server) getStationInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	st, present, err := currentStation(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	// Photos from main filtered by station.
	basePhotos, err := s.photosByStation(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	photos, err := applyPhotosOverlay(overlay, basePhotos, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	photoIDs := map[string]bool{}
	for _, p := range photos {
		photoIDs[p.ID] = true
	}
	baseIMs, err := s.imageMeasurementsByStation(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	ims, err := applyImageMeasurementsOverlay(overlay, baseIMs, photoIDs)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cpObsBase, err := s.cpObservationsByStation(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cpObs, err := mergeOverlay(cpObsBase, overlay[entityCPObservation],
		func(o CpObservation) string { return o.ID },
		decodeJSON[CpObservation],
		func(o CpObservation) bool { return o.StationID == id })
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	wantCPs := map[string]bool{}
	for _, im := range ims {
		if im.ControlPointID != nil {
			wantCPs[*im.ControlPointID] = true
		}
	}
	for _, o := range cpObs {
		wantCPs[o.ControlPointID] = true
	}
	baseCPs, err := s.controlPointsByStationOrObserved(ctx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cps, err := applyControlPointsOverlay(overlay, baseCPs, wantCPs)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, HydratedStation{
		Station:           st,
		Photos:            photos,
		ImageMeasurements: ims,
		ControlPoints:     cps,
		CpObservations:    cpObs,
	})
}

// Bbox filters from the non-session endpoints are dropped here — the index
// page calls these without a bbox.
func mergeListInSession[T any](
	overlay sessionOverlay, entityType string,
	fetchAll func() ([]T, error), idOf func(T) string,
) ([]T, error) {
	base, err := fetchAll()
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityType],
		idOf, decodeJSON[T], func(T) bool { return true })
}

func writeListInSession[T any](
	w http.ResponseWriter, overlay sessionOverlay,
	entityType string,
	fetchAll func() ([]T, error), idOf func(T) string,
) {
	out, err := mergeListInSession(overlay, entityType, fetchAll, idOf)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) listControlPointsInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeListInSession(w, overlay, entityControlPoint,
		func() ([]ControlPoint, error) { return s.allControlPoints(ctx) },
		func(cp ControlPoint) string { return cp.ID })
}

func (s *Server) listCPConstraintsInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeListInSession(w, overlay, entityCPConstraint,
		func() ([]CPConstraint, error) { return s.allCPConstraints(ctx) },
		func(c CPConstraint) string { return c.ID })
}

func (s *Server) listStationsInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeListInSession(w, overlay, entityStation,
		func() ([]Station, error) { return s.allStations(ctx) },
		func(st Station) string { return st.ID })
}

func (s *Server) listPhotosInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	photos, err := mergeListInSession(overlay, entityPhoto,
		func() ([]Photo, error) { return s.allPhotos(ctx) },
		func(p Photo) string { return p.ID })
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

// --- Photos ---

func (s *Server) postPhotoInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	stationID := requireID(w, r, "id")
	if stationID == "" {
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
	now := time.Now().UTC()
	opacity := 1.0
	if req.Opacity != nil {
		opacity = *req.Opacity
	}
	sizeRad := req.SizeRad
	if sizeRad == 0 {
		sizeRad = 0.5236
	}
	p := Photo{
		ID: id, StationID: stationID,
		Aspect: req.Aspect, PhotoAz: req.PhotoAz, PhotoTilt: req.PhotoTilt,
		PhotoRoll: req.PhotoRoll, SizeRad: sizeRad, Opacity: opacity,
		LockPhotoAz: true, LockPhotoTilt: true, LockPhotoRoll: true, LockSizeRad: true,
		LockDistK1: true, LockDistK2: true,
		CreatedAt: now, UpdatedAt: now,
	}
	if req.LockPhotoAz != nil {
		p.LockPhotoAz = *req.LockPhotoAz
	}
	if req.LockPhotoTilt != nil {
		p.LockPhotoTilt = *req.LockPhotoTilt
	}
	if req.LockPhotoRoll != nil {
		p.LockPhotoRoll = *req.LockPhotoRoll
	}
	if req.LockSizeRad != nil {
		p.LockSizeRad = *req.LockSizeRad
	}
	if req.DistK1 != nil {
		p.DistK1 = *req.DistK1
	}
	if req.DistK2 != nil {
		p.DistK2 = *req.DistK2
	}
	if req.LockDistK1 != nil {
		p.LockDistK1 = *req.LockDistK1
	}
	if req.LockDistK2 != nil {
		p.LockDistK2 = *req.LockDistK2
	}
	if err := s.recordOpDirect(r.Context(), sess.ID, entityPhoto, id, "insert", nil, jsonMust(p)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) putPhotoInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	patch, ok := parsePatch(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentPhoto(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	before := jsonMust(cur)
	if err := applyPhotoPatch(&cur, patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	cur.UpdatedAt = time.Now().UTC()
	if err := s.recordOpDirect(ctx, sess.ID, entityPhoto, id, "update", before, jsonMust(cur)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cur)
}

func (s *Server) deletePhotoInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	p, present, err := currentPhoto(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	ims, err := s.collectImageMeasurementsForPhoto(ctx, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, im := range ims {
		if err := recordOp(ctx, tx, sess.ID, entityImageMeasurement, im.ID, "delete", jsonMust(im), nil); err != nil {
			writeErrorFromDB(w, err)
			return
		}
	}
	if err := recordOp(ctx, tx, sess.ID, entityPhoto, id, "delete", jsonMust(p), nil); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getPhotoInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	p, present, err := currentPhoto(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// putPhotoBlobInSession writes the blob bytes to disk (orphan-on-abandon)
// and journals a photo update with the new blob_path / mime_type /
// size_bytes. The photo row may exist only in the session overlay — that's
// fine; loading via currentPhoto handles both cases.
func (s *Server) putPhotoBlobInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	mime := r.Header.Get("Content-Type")
	if !strings.HasPrefix(mime, "image/") {
		writeError(w, http.StatusBadRequest, "Content-Type must be image/*")
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentPhoto(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	body := http.MaxBytesReader(w, r.Body, s.maxBlobBytes)
	path, n, err := s.blobs.writeBlob(body, s.maxBlobBytes)
	if err != nil {
		if errors.Is(err, errPayloadTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "blob too large")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	before := jsonMust(cur)
	cur.BlobPath = &path
	cur.MimeType = &mime
	cur.SizeBytes = &n
	cur.UpdatedAt = time.Now().UTC()
	if err := s.recordOpDirect(ctx, sess.ID, entityPhoto, id, "update", before, jsonMust(cur)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Image measurements ---

func (s *Server) postImageMeasurementInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	photoID := requireID(w, r, "id")
	if photoID == "" {
		return
	}
	var req ImageMeasurementPatch
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateImageMeasurementPatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}

	// When the new measurement links to a CP, ensure the per-station
	// cp_observation row exists with status=observed. The image-measurement
	// pixel pin is evidence backing the observation; the two facts must
	// agree, so we either auto-create the observed row or refuse if a
	// missing/cant_see contradicts it.
	var observedToCreate *CpObservation
	if req.ControlPointID != nil {
		photo, present, err := currentPhoto(ctx, s.db, overlay, photoID)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		if !present {
			writeError(w, http.StatusNotFound, "photo not found")
			return
		}
		existing, err := s.findCpObservationByPair(ctx, overlay, photo.StationID, *req.ControlPointID)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		if existing != nil && existing.Status != Observed {
			writeError(w, http.StatusConflict,
				"cp_observation at this station is "+string(existing.Status)+"; resolve before adding a pixel pin")
			return
		}
		if existing == nil {
			now := time.Now().UTC()
			observedToCreate = &CpObservation{
				ID:             newID(),
				StationID:      photo.StationID,
				ControlPointID: *req.ControlPointID,
				Status:         Observed,
				CreatedAt:      now,
				UpdatedAt:      now,
			}
		}
	}

	id := newID()
	now := time.Now().UTC()
	im := ImageMeasurement{
		ID: id, PhotoID: photoID, U: req.U, V: req.V, ControlPointID: req.ControlPointID,
		CreatedAt: now, UpdatedAt: now,
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if observedToCreate != nil {
		if err := recordOp(ctx, tx, sess.ID, entityCPObservation, observedToCreate.ID,
			"insert", nil, jsonMust(*observedToCreate)); err != nil {
			writeErrorFromDB(w, err)
			return
		}
	}
	if err := recordOp(ctx, tx, sess.ID, entityImageMeasurement, id, "insert", nil, jsonMust(im)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if observedToCreate != nil {
		if err := runPropagationInTx(ctx, tx, sess.ID); err != nil {
			writeErrorFromDB(w, err)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, im)
}

func (s *Server) putImageMeasurementInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	patch, ok := parsePatch(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentImageMeasurement(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	before := jsonMust(cur)
	if err := applyImageMeasurementPatch(&cur, patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	cur.UpdatedAt = time.Now().UTC()
	if err := s.recordOpDirect(ctx, sess.ID, entityImageMeasurement, id, "update", before, jsonMust(cur)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cur)
}

func (s *Server) deleteImageMeasurementInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentImageMeasurement(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := s.recordOpDirect(ctx, sess.ID, entityImageMeasurement, id, "delete", jsonMust(cur), nil); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Control points ---

func (s *Server) postControlPointInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	var req ControlPointPatch
	if !parseJSON(w, r, &req) {
		return
	}
	if msg := validateControlPointPatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	id := newID()
	now := time.Now().UTC()
	cp := ControlPoint{ID: id, CreatedAt: now, UpdatedAt: now}
	if req.Description != nil {
		cp.Description = *req.Description
	}
	if req.Notes != nil {
		cp.Notes = *req.Notes
	}
	cp.EstLat = req.EstLat
	cp.EstLng = req.EstLng
	cp.EstAlt = req.EstAlt
	cp.StartedAt = req.StartedAt
	cp.EndedAt = req.EndedAt
	// Precise dates seed both bounds of their side; observations at merge
	// time may tighten the other side.
	cp.DerivedWindow = DerivedWindow{
		StartedAtLower: req.StartedAt,
		StartedAtUpper: req.StartedAt,
		EndedAtLower:   req.EndedAt,
		EndedAtUpper:   req.EndedAt,
	}
	if req.LockEstLat != nil {
		cp.LockEstLat = *req.LockEstLat
	}
	if req.LockEstLng != nil {
		cp.LockEstLng = *req.LockEstLng
	}
	if req.LockEstAlt != nil {
		cp.LockEstAlt = *req.LockEstAlt
	}
	if err := s.recordOpDirect(r.Context(), sess.ID, entityControlPoint, id, "insert", nil, jsonMust(cp)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, cp)
}

func (s *Server) putControlPointInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	patch, ok := parsePatch(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentControlPoint(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	before := jsonMust(cur)
	if err := applyControlPointPatch(&cur, patch); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	cur.UpdatedAt = time.Now().UTC()
	if err := s.recordOpDirect(ctx, sess.ID, entityControlPoint, id, "update", before, jsonMust(cur)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cur)
}

func (s *Server) deleteControlPointInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentControlPoint(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	// FKs are RESTRICT (migration 0024) — the session must journal an
	// explicit delete for every dependent so revert can restore them.
	ims, err := s.imageMeasurementsForCP(ctx, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	constraints, err := s.collectCPConstraintsForCP(ctx, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	surfaces, err := s.collectCPSurfacesForCP(ctx, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cpObs, err := s.collectCpObservationsForCP(ctx, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, o := range cpObs {
		if err := recordOp(ctx, tx, sess.ID, entityCPObservation, o.ID, "delete", jsonMust(o), nil); err != nil {
			writeErrorFromDB(w, err)
			return
		}
	}
	for _, im := range ims {
		if err := recordOp(ctx, tx, sess.ID, entityImageMeasurement, im.ID, "delete", jsonMust(im), nil); err != nil {
			writeErrorFromDB(w, err)
			return
		}
	}
	for _, c := range constraints {
		if err := recordOp(ctx, tx, sess.ID, entityCPConstraint, c.ID, "delete", jsonMust(c), nil); err != nil {
			writeErrorFromDB(w, err)
			return
		}
	}
	for _, sf := range surfaces {
		if err := recordOp(ctx, tx, sess.ID, entityCPSurface, sf.ID, "delete", jsonMust(sf), nil); err != nil {
			writeErrorFromDB(w, err)
			return
		}
	}
	if err := recordOp(ctx, tx, sess.ID, entityControlPoint, id, "delete", jsonMust(cur), nil); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if err := runPropagationInTx(ctx, tx, sess.ID); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) collectCPConstraintsForCP(ctx context.Context, overlay sessionOverlay, cpID string) ([]CPConstraint, error) {
	base, err := s.cpConstraintsByCP(ctx, cpID)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityCPConstraint],
		func(c CPConstraint) string { return c.ID },
		decodeJSON[CPConstraint],
		func(c CPConstraint) bool { return c.CpAId == cpID || c.CpBId == cpID })
}

func (s *Server) collectCPSurfacesForCP(ctx context.Context, overlay sessionOverlay, cpID string) ([]CPSurface, error) {
	base, err := s.cpSurfacesByCP(ctx, cpID)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityCPSurface],
		func(sf CPSurface) string { return sf.ID },
		decodeJSON[CPSurface],
		func(sf CPSurface) bool {
			if sf.Cp1ID == cpID || sf.Cp2ID == cpID || sf.Cp3ID == cpID {
				return true
			}
			return sf.Cp4ID != nil && *sf.Cp4ID == cpID
		})
}

func (s *Server) getControlPointInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cp, present, err := currentControlPoint(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, cp)
}

// imageMeasurementsForCP returns the rows that, after applying the session
// overlay, currently reference cpID. Picks up session-inserted measurements
// and rows rerouted to/away from cpID by the session.
func (s *Server) imageMeasurementsForCP(ctx context.Context, overlay sessionOverlay, cpID string) ([]ImageMeasurement, error) {
	base, err := s.imageMeasurementsByControlPoint(ctx, cpID)
	if err != nil {
		return nil, err
	}
	return mergeOverlay(base, overlay[entityImageMeasurement],
		func(im ImageMeasurement) string { return im.ID },
		decodeJSON[ImageMeasurement],
		func(im ImageMeasurement) bool {
			return im.ControlPointID != nil && *im.ControlPointID == cpID
		})
}

// cpLifespanIncludes reports whether `t` falls inside the CP's derived
// lifespan window. The window's bounds already fold in any precise
// started_at/ended_at; nil bounds mean "no evidence on that side."
// A nil `t` (station with unknown capture date) passes the gate — it
// contributes no temporal evidence and shouldn't be excluded.
func cpLifespanIncludes(cp ControlPoint, t *time.Time) bool {
	if t == nil {
		return true
	}
	if cp.DerivedWindow.StartedAtLower != nil && t.Before(*cp.DerivedWindow.StartedAtLower) {
		return false
	}
	if cp.DerivedWindow.EndedAtUpper != nil && t.After(*cp.DerivedWindow.EndedAtUpper) {
		return false
	}
	return true
}

// timePtrLess orders nil last; ties broken by Before semantics.
func timePtrLess(a, b *time.Time) bool {
	if a == nil {
		return false
	}
	if b == nil {
		return true
	}
	return a.Before(*b)
}

// timePtrEqual compares two nullable times by value.
func timePtrEqual(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

func (s *Server) listControlPointObservationsInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if _, present, err := currentControlPoint(ctx, s.db, overlay, id); err != nil {
		writeErrorFromDB(w, err)
		return
	} else if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	ims, err := s.imageMeasurementsForCP(ctx, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	type obsRow struct {
		im ImageMeasurement
		p  Photo
		st Station
	}
	rows := make([]obsRow, 0, len(ims))
	for _, im := range ims {
		p, present, err := currentPhoto(ctx, s.db, overlay, im.PhotoID)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		if !present {
			continue
		}
		st, present, err := currentStation(ctx, s.db, overlay, p.StationID)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		if !present {
			continue
		}
		rows = append(rows, obsRow{im, p, st})
	}
	sort.Slice(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if !timePtrEqual(a.st.CapturedAt, b.st.CapturedAt) {
			return timePtrLess(a.st.CapturedAt, b.st.CapturedAt)
		}
		return a.im.CreatedAt.Before(b.im.CreatedAt)
	})
	out := make([]ControlPointImageObservation, 0, len(rows))
	for _, r := range rows {
		out = append(out, ControlPointImageObservation{
			ID:                   r.im.ID,
			PhotoID:              r.im.PhotoID,
			U:                    r.im.U,
			V:                    r.im.V,
			StationID:            r.p.StationID,
			StationName:          r.st.Name,
			StationLat:           r.st.Lat,
			StationLng:           r.st.Lng,
			StationCapturedAt:    r.st.CapturedAt,
			StationDerivedWindow: r.st.DerivedWindow,
			PhotoAz:              r.p.PhotoAz,
			PhotoTilt:            r.p.PhotoTilt,
			PhotoRoll:            r.p.PhotoRoll,
			SizeRad:              r.p.SizeRad,
			Aspect:               r.p.Aspect,
		})
	}
	writeJSON(w, http.StatusOK, ControlPointObservations{ImageMeasurements: out})
}

func (s *Server) listControlPointVisiblePhotosInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cp, present, err := currentControlPoint(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	out := ControlPointVisiblePhotos{Photos: []ControlPointVisiblePhoto{}}
	if cp.EstLat == nil || cp.EstLng == nil {
		writeJSON(w, http.StatusOK, out)
		return
	}

	linkedIMs, err := s.imageMeasurementsForCP(ctx, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	taken := make(map[string]bool, len(linkedIMs))
	for _, im := range linkedIMs {
		taken[im.PhotoID] = true
	}

	basePhotos, err := s.allPhotos(ctx)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	photos, err := mergeOverlay(basePhotos, overlay[entityPhoto],
		func(p Photo) string { return p.ID },
		decodeJSON[Photo],
		func(Photo) bool { return true })
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}

	withDist := make([]visiblePhotoWithDist, 0, len(photos))
	for _, p := range photos {
		if taken[p.ID] {
			continue
		}
		st, present, err := currentStation(ctx, s.db, overlay, p.StationID)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		if !present {
			continue
		}
		if !cpLifespanIncludes(cp, st.CapturedAt) {
			continue
		}
		if !inHorizontalViewshed(st.Lat, st.Lng, *cp.EstLat, *cp.EstLng, p.PhotoAz, p.SizeRad) {
			continue
		}
		withDist = append(withDist, visiblePhotoWithDist{
			photo: ControlPointVisiblePhoto{
				PhotoID:              p.ID,
				StationID:            p.StationID,
				StationName:          st.Name,
				StationCapturedAt:    st.CapturedAt,
				StationDerivedWindow: st.DerivedWindow,
			},
			distM: equirectDistMeters(st.Lat, st.Lng, *cp.EstLat, *cp.EstLng),
		})
	}
	out.Photos = sortVisiblePhotosByDist(withDist)
	writeJSON(w, http.StatusOK, out)
}

// --- CP constraints ---

func (s *Server) postCPConstraintInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	var req CPConstraintCreate
	if !parseJSON(w, r, &req) {
		return
	}
	if !validID(req.CpAId) || !validID(req.CpBId) {
		writeError(w, http.StatusBadRequest, "invalid cp_a_id or cp_b_id")
		return
	}
	if req.CpAId == req.CpBId {
		writeError(w, http.StatusBadRequest, "cp_a_id and cp_b_id must differ")
		return
	}
	if !req.ConstraintType.Valid() {
		writeError(w, http.StatusBadRequest, "constraint_type must be 'plumb' or 'level'")
		return
	}
	a, b := req.CpAId, req.CpBId
	if a > b {
		a, b = b, a
	}
	id := newID()
	now := time.Now().UTC()
	c := CPConstraint{
		ID: id, CpAId: a, CpBId: b, ConstraintType: req.ConstraintType,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.recordOpDirect(r.Context(), sess.ID, entityCPConstraint, id, "insert", nil, jsonMust(c)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) putCPConstraintInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req CPConstraintPatch
	if !parseJSON(w, r, &req) {
		return
	}
	if req.ConstraintType == nil {
		writeError(w, http.StatusBadRequest, "no updatable fields")
		return
	}
	if !req.ConstraintType.Valid() {
		writeError(w, http.StatusBadRequest, "constraint_type must be 'plumb' or 'level'")
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentCPConstraint(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	before := jsonMust(cur)
	cur.ConstraintType = *req.ConstraintType
	cur.UpdatedAt = time.Now().UTC()
	if err := s.recordOpDirect(ctx, sess.ID, entityCPConstraint, id, "update", before, jsonMust(cur)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cur)
}

func (s *Server) deleteCPConstraintInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentCPConstraint(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := s.recordOpDirect(ctx, sess.ID, entityCPConstraint, id, "delete", jsonMust(cur), nil); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- CP surfaces ---

func (s *Server) postCPSurfaceInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	var req CPSurfaceCreate
	if !parseJSON(w, r, &req) {
		return
	}
	if !validID(req.Cp1ID) || !validID(req.Cp2ID) || !validID(req.Cp3ID) {
		writeError(w, http.StatusBadRequest, "invalid cp id")
		return
	}
	if req.Cp4ID != nil && !validID(*req.Cp4ID) {
		writeError(w, http.StatusBadRequest, "invalid cp_4_id")
		return
	}
	// Distinctness: the 3 required CPs must be pairwise distinct, and
	// (when present) cp_4_id must differ from each of the others.
	seen := map[string]bool{req.Cp1ID: true}
	for _, id := range []string{req.Cp2ID, req.Cp3ID} {
		if seen[id] {
			writeError(w, http.StatusBadRequest, "cp ids must be distinct")
			return
		}
		seen[id] = true
	}
	if req.Cp4ID != nil && seen[*req.Cp4ID] {
		writeError(w, http.StatusBadRequest, "cp ids must be distinct")
		return
	}
	id := newID()
	now := time.Now().UTC()
	sf := CPSurface{
		ID: id, Cp1ID: req.Cp1ID, Cp2ID: req.Cp2ID, Cp3ID: req.Cp3ID, Cp4ID: req.Cp4ID,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.recordOpDirect(r.Context(), sess.ID, entityCPSurface, id, "insert", nil, jsonMust(sf)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, sf)
}

func (s *Server) listCPSurfacesInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeListInSession(w, overlay, entityCPSurface,
		func() ([]CPSurface, error) { return s.allCPSurfaces(ctx) },
		func(sf CPSurface) string { return sf.ID })
}

func (s *Server) deleteCPSurfaceInSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	overlay, err := loadSessionOverlay(ctx, s.db, sess.ID)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	cur, present, err := currentCPSurface(ctx, s.db, overlay, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if !present {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := s.recordOpDirect(ctx, sess.ID, entityCPSurface, id, "delete", jsonMust(cur), nil); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- helpers for cascade delete ---

// collectPhotosForCascade returns every photo currently belonging to the
// station after the session overlay is applied — i.e. the rows a cascade
// delete needs to journal.
func (s *Server) collectPhotosForCascade(ctx context.Context, overlay sessionOverlay, stationID string) ([]Photo, error) {
	base, err := s.photosByStation(ctx, stationID)
	if err != nil {
		return nil, err
	}
	return applyPhotosOverlay(overlay, base, stationID)
}

func (s *Server) collectImageMeasurementsForPhoto(ctx context.Context, overlay sessionOverlay, photoID string) ([]ImageMeasurement, error) {
	base, err := s.imageMeasurementsByPhoto(ctx, photoID)
	if err != nil {
		return nil, err
	}
	return applyImageMeasurementsOverlay(overlay, base, map[string]bool{photoID: true})
}

// --- helpers we add to existing files (not handlers themselves) ---

// imageMeasurementsByPhoto reads the rows for one photo from main. Used by
// collectImageMeasurementsForPhoto.
func (s *Server) imageMeasurementsByPhoto(ctx context.Context, photoID string) ([]ImageMeasurement, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+imageMeasurementCols+` FROM image_measurements WHERE photo_id=$1 ORDER BY created_at`,
		photoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ImageMeasurement{}
	for rows.Next() {
		im, err := scanImageMeasurement(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, im)
	}
	return out, rows.Err()
}

func (s *Server) allControlPoints(ctx context.Context) ([]ControlPoint, error) {
	rows, err := s.db.Query(ctx, `SELECT `+controlPointCols+` FROM control_points ORDER BY created_at DESC LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ControlPoint{}
	for rows.Next() {
		cp, err := scanControlPoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, cp)
	}
	return out, rows.Err()
}

func (s *Server) allCPConstraints(ctx context.Context) ([]CPConstraint, error) {
	rows, err := s.db.Query(ctx, `SELECT `+cpConstraintCols+` FROM cp_constraints ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CPConstraint{}
	for rows.Next() {
		c, err := scanCPConstraint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Server) allCPSurfaces(ctx context.Context) ([]CPSurface, error) {
	rows, err := s.db.Query(ctx, `SELECT `+cpSurfaceCols+` FROM cp_surfaces ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CPSurface{}
	for rows.Next() {
		v, err := scanCPSurface(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Server) allStations(ctx context.Context) ([]Station, error) {
	rows, err := s.db.Query(ctx, `SELECT `+stationCols+` FROM stations ORDER BY created_at DESC LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Station{}
	for rows.Next() {
		st, err := scanStation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}
