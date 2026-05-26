package main

import "net/http"

// registerSolveRoutes mounts the solver proxy endpoints on mux. The api
// service forwards each call to the private solver service (see
// solver_client.go + solver/). Always registered — the api ships no
// in-process Ceres, just the HTTP forwarding.
func (s *Server) registerSolveRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/solve/warmup", s.postSolveWarmup)
	mux.HandleFunc("POST /api/solve/joint", s.postSolveJoint)
	mux.HandleFunc("POST /api/solve/joint/stream", s.postSolveJointStream)
	mux.HandleFunc("POST /api/solve/stop", s.postSolveStop)
	mux.HandleFunc("POST /api/solve/stations/{id}", s.postSolveStation)
	mux.HandleFunc("POST /api/solve/stations/{id}/stream", s.postSolveStationStream)
	mux.HandleFunc("POST /api/solve/control-points/{id}", s.postSolveControlPoint)
}
