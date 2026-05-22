//go:build noceres

package main

import "net/http"

// registerSolveRoutes is a no-op in the noceres (reader) build: the solver
// package and its cgo Ceres binding aren't compiled, so the /api/solve/*
// routes simply don't exist. Requests fall through to the SPA fallback and
// receive a 404 from the SPA's client-side router.
func (s *Server) registerSolveRoutes(_ *http.ServeMux) {}
