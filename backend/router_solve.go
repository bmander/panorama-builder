//go:build !noceres

package main

import "net/http"

// registerSolveRoutes mounts the Ceres-backed solver endpoints on mux.
// Compiled only when the binary is built with the solver (default build);
// the `noceres` reader build uses the stub in router_solve_stub.go.
func (s *Server) registerSolveRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/solve/joint", s.postSolveJoint)
	mux.HandleFunc("POST /api/solve/joint/stream", s.postSolveJointStream)
	mux.HandleFunc("POST /api/solve/stop", s.postSolveStop)
	mux.HandleFunc("POST /api/solve/stations/{id}", s.postSolveStation)
	mux.HandleFunc("POST /api/solve/stations/{id}/stream", s.postSolveStationStream)
	mux.HandleFunc("POST /api/solve/control-points/{id}", s.postSolveControlPoint)
}
