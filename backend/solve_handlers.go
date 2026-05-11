package main

import (
	"errors"
	"log"
	"net/http"

	"github.com/bmander/panorama-builder/backend/solver"
)

// Synchronous solver handlers (joint + single-station + single-CP). The
// streaming joint variant lives in solve_stream.go. All four take
// Server.solveMu so only one solve runs at a time. Session-mode solves are
// preview-only: results are returned to the client but never persisted —
// the canonical writeback happens at merge time, where the server re-runs
// the joint solver against the freshly-applied intent state.

func (s *Server) postSolveJoint(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	cfg, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeJoint
	s.runSolve(w, r, cfg, sess)
}

func (s *Server) postSolveStation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	cfg, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeSingleStation
	cfg.FocusID = id
	s.runSolve(w, r, cfg, sess)
}

func (s *Server) postSolveControlPoint(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	cfg, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeSingleControlPoint
	cfg.FocusID = id
	s.runSolve(w, r, cfg, sess)
}

func parseSolveConfig(w http.ResponseWriter, r *http.Request) (solver.Config, bool) {
	cfg := solver.Config{}
	if r.ContentLength == 0 {
		return cfg, true
	}
	var req SolveConfig
	if !parseJSON(w, r, &req) {
		return cfg, false
	}
	if req.MaxIters != nil {
		cfg.MaxIters = *req.MaxIters
	}
	if req.ResidualTolRad != nil {
		cfg.ResidualTolRad = *req.ResidualTolRad
	}
	if req.RelImproveTol != nil {
		cfg.RelImproveTol = *req.RelImproveTol
	}
	if req.KRegLambda != nil {
		cfg.KRegLambda = *req.KRegLambda
	}
	// req.DryRun is accepted for back-compat but ignored: every session-mode
	// solve is effectively a dry run (no journal writes).
	return cfg, true
}

func (s *Server) runSolve(w http.ResponseWriter, r *http.Request, cfg solver.Config, sess *Session) {
	s.solveMu.Lock()
	defer s.solveMu.Unlock()

	ctx := r.Context()
	var prob solver.Problem
	var seededCPIDs []string
	var exists bool
	var err error
	if cfg.Mode == solver.ModeJoint {
		prob, seededCPIDs, err = s.loadJointProblemSession(ctx, sess)
		exists = true
	} else {
		// Single-station / single-CP loaders aren't overlay-aware yet: they
		// read inputs from main only. Their outputs are still returned to
		// the client as preview; the canonical writeback is the joint solve
		// at merge time.
		prob, seededCPIDs, exists, err = s.loadProblem(ctx, cfg)
	}
	if err != nil {
		log.Printf("solver load: %v", err)
		writeError(w, http.StatusInternalServerError, "load failed")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "focus entity not found")
		return
	}

	var res solver.Result
	if cfg.Mode == solver.ModeJoint {
		res, err = solver.SolveJointWithSeed(prob, seededCPIDs, cfg)
	} else {
		res, err = solver.Solve(prob, cfg)
	}
	if err != nil {
		switch {
		case errors.Is(err, solver.ErrUnderconstrainedGauge):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, solver.ErrFocusNotFound):
			writeError(w, http.StatusNotFound, err.Error())
		case errors.Is(err, solver.ErrInsufficientObservations):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			log.Printf("solver: %v", err)
			writeError(w, http.StatusInternalServerError, "solver failed")
		}
		return
	}
	writeJSON(w, http.StatusOK, toAPISolveResult(res))
}

func toAPISolveResult(r solver.Result) SolveResult {
	out := SolveResult{
		Iterations:         r.Iterations,
		InitialResidualRms: r.InitialResidualRMS,
		FinalResidualRms:   r.FinalResidualRMS,
		Converged:          r.Converged,
		Diverged:           r.Diverged,
	}
	if len(r.AutoLockedColumns) > 0 {
		cols := append([]string(nil), r.AutoLockedColumns...)
		out.AutoLockedColumns = &cols
	}
	out.Changes = make([]EntityChange, 0, len(r.Changes))
	for _, c := range r.Changes {
		out.Changes = append(out.Changes, EntityChange{
			Kind:   EntityChangeKind(c.Kind),
			ID:     c.ID,
			Before: c.Before,
			After:  c.After,
		})
	}
	return out
}
