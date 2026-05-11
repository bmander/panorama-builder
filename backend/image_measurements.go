package main

import (
	"net/http"

	"github.com/jackc/pgx/v5"
)

// All writes go through the session-aware paths in
// session_entity_handlers.go. There is no read-by-id endpoint for an image
// measurement on its own (the hydrated station GET carries the per-station
// list with overlay applied).

const imageMeasurementCols = `id, photo_id, u, v, control_point_id, created_at, updated_at`

func scanImageMeasurement(row pgx.Row) (ImageMeasurement, error) {
	var im ImageMeasurement
	err := row.Scan(&im.ID, &im.PhotoID, &im.U, &im.V, &im.ControlPointID, &im.CreatedAt, &im.UpdatedAt)
	return im, err
}

func (s *Server) postImageMeasurement(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.postImageMeasurementInSession(w, r, sess)
}

func (s *Server) putImageMeasurement(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.putImageMeasurementInSession(w, r, sess)
}

func (s *Server) deleteImageMeasurement(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.deleteImageMeasurementInSession(w, r, sess)
}
