package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/bmander/panorama-builder/shared/wire"
)

// Synchronous solver handlers (joint + single-station + single-CP). The
// streaming joint variant lives in solve_stream.go. All four take
// Server.solveMu so only one solve runs at a time on this api instance.
//
// Each handler loads the Problem from the DB (session-overlay-aware), then
// hands it to the private solver service via s.solver. The solver service
// (solver/) runs Ceres and returns a wire.Result; the api writes
// resulting changes back through the session journal.

// postSolveWarmup nudges the private solver service awake when the user enters
// edit mode, so a scaled-to-zero instance is already spinning up by the time a
// solve actually fires. It mutates no shared state — no journal op, no commit —
// so unlike the real solve handlers it skips requireSession entirely.
//
// The nudge is fire-and-forget: we hand it to a detached, time-bounded context
// and 202 immediately rather than holding the request open for the solver's
// cold start. There's deliberately no keep-alive loop — a single ping per edit
// click is the whole mechanism, so an idle edit session lets the solver fall
// back asleep on its own.
func (s *Server) postSolveWarmup(w http.ResponseWriter, _ *http.Request) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := s.solver.Warmup(ctx); err != nil {
			log.Printf("solver warmup: %v", err)
		}
	}()
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) postSolveJoint(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	p, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	p.cfg.Mode = wire.ModeJoint
	s.runSolve(w, r, p.cfg, p.dryRun, sess)
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
	p, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	p.cfg.Mode = wire.ModeSingleStation
	p.cfg.FocusID = id
	s.runSolve(w, r, p.cfg, p.dryRun, sess)
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
	p, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	p.cfg.Mode = wire.ModeSingleControlPoint
	p.cfg.FocusID = id
	s.runSolve(w, r, p.cfg, p.dryRun, sess)
}

// solveParams is the parsed solve request: the solver-bound config DTO plus
// api-only flags that never cross the solver wire. dryRun gates the api's
// session writeback — the solver always computes and returns the would-be
// changes; on a dry run we simply don't journal them — so it deliberately
// stays out of wire.SolveConfigDTO, which mirrors the solver's own Config.
type solveParams struct {
	cfg    wire.SolveConfigDTO
	dryRun bool
}

func parseSolveConfig(w http.ResponseWriter, r *http.Request) (solveParams, bool) {
	p := solveParams{}
	if r.ContentLength == 0 {
		return p, true
	}
	var req SolveConfig
	if !parseJSON(w, r, &req) {
		return p, false
	}
	if req.MaxIters != nil {
		p.cfg.MaxIters = *req.MaxIters
	}
	if req.FunctionTol != nil {
		p.cfg.FunctionTol = *req.FunctionTol
	}
	if req.StepTol != nil {
		p.cfg.StepTol = *req.StepTol
	}
	if req.KRegLambda != nil {
		p.cfg.KRegLambda = *req.KRegLambda
	}
	if req.PositionRegLambda != nil {
		p.cfg.PositionRegLambda = *req.PositionRegLambda
	}
	if req.DryRun != nil {
		p.dryRun = *req.DryRun
	}
	return p, true
}

func (s *Server) runSolve(w http.ResponseWriter, r *http.Request, cfg wire.SolveConfigDTO, dryRun bool, sess *Session) {
	s.solveMu.Lock()
	defer s.solveMu.Unlock()

	ctx := r.Context()
	prob, seededCPIDs, exists, err := s.loadProblem(ctx, cfg, sess)
	if err != nil {
		log.Printf("solver load: %v", err)
		writeError(w, http.StatusInternalServerError, "load failed")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "focus entity not found")
		return
	}

	res, err := s.solver.Solve(ctx, prob, cfg, seededCPIDs)
	if err != nil {
		switch {
		case errors.Is(err, wire.ErrUnderconstrainedGauge):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, wire.ErrFocusNotFound):
			writeError(w, http.StatusNotFound, err.Error())
		case errors.Is(err, wire.ErrInsufficientObservations):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			log.Printf("solver: %v", err)
			writeError(w, http.StatusInternalServerError, "solver failed")
		}
		return
	}
	// dry_run previews the fit: the solver still returns the would-be changes
	// (surfaced in the result for the UI), but we journal nothing and leave
	// session metadata untouched, so the run has no persistent effect.
	if !dryRun {
		if err := s.writebackChangesInSession(ctx, sess.ID, res.Changes); err != nil {
			log.Printf("solver writeback: %v", err)
			writeError(w, http.StatusInternalServerError, "writeback failed")
			return
		}
		if err := s.recordSolveRMS(ctx, sess.ID, res.FinalResidualRMS); err != nil {
			log.Printf("solver rms record: %v", err)
		}
	}
	writeJSON(w, http.StatusOK, toAPISolveResult(res))
}

// recordSolveRMS stamps the session's last_solve_rms so mergeSession can
// record it on the resulting commit's fit_score. Best-effort: a failure
// here doesn't fail the solve.
func (s *Server) recordSolveRMS(ctx context.Context, sessionID string, rms float64) error {
	_, err := s.db.Exec(ctx,
		`UPDATE sessions SET last_solve_rms = $1, updated_at = NOW() WHERE id = $2`,
		rms, sessionID)
	return err
}

func toAPISolveResult(r wire.Result) SolveResult {
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
