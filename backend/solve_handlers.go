package main

import (
	"errors"
	"log"
	"net/http"

	"github.com/bmander/panorama-builder/backend/solver"
)

// Synchronous solver handlers (joint + single-station + single-CP). The
// streaming joint variant lives in solve_stream.go. All four take
// Server.solveMu, so only one solve runs at a time. Writeback uses
// updated_at as an optimistic-concurrency token; a stale snapshot surfaces
// as a 409 instead of silently overwriting a concurrent edit.

func (s *Server) postSolveJoint(w http.ResponseWriter, r *http.Request) {
	cfg, dryRun, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeJoint
	s.runSolve(w, r, cfg, dryRun)
}

func (s *Server) postSolveStation(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	cfg, dryRun, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeSingleStation
	cfg.FocusID = id
	s.runSolve(w, r, cfg, dryRun)
}

func (s *Server) postSolveControlPoint(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	cfg, dryRun, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeSingleControlPoint
	cfg.FocusID = id
	s.runSolve(w, r, cfg, dryRun)
}

func parseSolveConfig(w http.ResponseWriter, r *http.Request) (solver.Config, bool, bool) {
	cfg := solver.Config{}
	dryRun := false
	if r.ContentLength == 0 {
		return cfg, dryRun, true
	}
	var req SolveConfig
	if !parseJSON(w, r, &req) {
		return cfg, dryRun, false
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
	if req.DryRun != nil {
		dryRun = *req.DryRun
	}
	return cfg, dryRun, true
}

func (s *Server) runSolve(w http.ResponseWriter, r *http.Request, cfg solver.Config, dryRun bool) {
	s.solveMu.Lock()
	defer s.solveMu.Unlock()

	ctx := r.Context()
	prob, seededCPIDs, exists, err := s.loadProblem(ctx, cfg)
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

	if !dryRun && !res.Diverged && len(res.Changes) > 0 {
		if err := s.writebackChanges(ctx, prob, res); err != nil {
			if errors.Is(err, errConcurrentEdit) {
				writeError(w, http.StatusConflict, "concurrent edit; refresh and retry")
				return
			}
			log.Printf("solver writeback: %v", err)
			writeError(w, http.StatusInternalServerError, "writeback failed")
			return
		}
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
