package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"

	"github.com/bmander/panorama-builder/backend/solver"
)

// postSolveJointStream is the SSE counterpart to postSolveJoint. The client
// receives one event per Gauss-Newton iteration as it happens, then a final
// terminal event. Each event is one line of the form
//
//	data: {"kind":"iter","iter":N,"rms":R,"accepted":bool}\n\n
//	data: {"kind":"done","result":{...SolveResult JSON...}}\n\n
//	data: {"kind":"stopped","result":{...SolveResult JSON...}}\n\n
//	data: {"kind":"cancelled"}\n\n
//	data: {"kind":"error","message":"..."}\n\n
//
// done    — solver ran to completion (converged / diverged / iter cap).
//
//	Writeback happened iff !dry_run, !diverged, and there were changes.
//
// stopped — user clicked "stop here"; the best iterate was written back
//
//	(skipped only on dry_run / diverged / no-changes).
//
// cancelled — user aborted (closed connection); no writeback.
//
// Joint mode only — single-station / single-CP keep their synchronous endpoints.
func (s *Server) postSolveJointStream(w http.ResponseWriter, r *http.Request) {
	cfg, dryRun, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeJoint
	// Streaming default: keep iterating until convergence/divergence finds a
	// natural stop. The user can interrupt via Cancel / Stop here, so a hard
	// cap mainly guards against pathological non-converging configurations.
	if cfg.MaxIters == 0 {
		cfg.MaxIters = 1000
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	s.solveMu.Lock()
	defer s.solveMu.Unlock()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	sendEvent := func(payload any) {
		body, err := json.Marshal(payload)
		if err != nil {
			log.Printf("solve stream marshal: %v", err)
			return
		}
		fmt.Fprintf(w, "data: %s\n\n", body)
		flusher.Flush()
	}
	sendError := func(msg string) {
		sendEvent(map[string]string{"kind": "error", "message": msg})
	}

	ctx := r.Context()
	prob, err := s.loadJointProblem(ctx)
	if err != nil {
		log.Printf("solver load: %v", err)
		sendError("load failed")
		return
	}

	// Register a stop channel so /api/solve/joint/stop can fire it.
	stopCh := make(chan struct{}, 1)
	s.activeStopMu.Lock()
	s.activeStop = stopCh
	s.activeStopMu.Unlock()
	defer func() {
		s.activeStopMu.Lock()
		s.activeStop = nil
		s.activeStopMu.Unlock()
	}()

	stopRequested := false
	cfg.OnIteration = func(iter int, rms float64, accepted bool) {
		sendEvent(map[string]any{
			"kind": "iter", "iter": iter, "rms": rms, "accepted": accepted,
		})
	}
	cfg.ShouldStop = func() bool {
		select {
		case <-ctx.Done():
			return true
		case <-stopCh:
			stopRequested = true
			return true
		default:
			return false
		}
	}

	res, err := solver.Solve(prob, cfg)
	if err != nil {
		sendError(err.Error())
		return
	}

	if ctx.Err() != nil {
		// Client aborted — stream is already torn down on the wire, but try
		// to write a terminal event for any reader still listening.
		sendEvent(map[string]string{"kind": "cancelled"})
		return
	}

	if !dryRun && !res.Diverged && len(res.Changes) > 0 {
		if err := s.writebackChanges(ctx, prob, res); err != nil {
			if errors.Is(err, errConcurrentEdit) {
				sendError("concurrent edit; refresh and retry")
				return
			}
			log.Printf("solver writeback: %v", err)
			sendError("writeback failed")
			return
		}
	}

	terminalKind := "done"
	if stopRequested {
		terminalKind = "stopped"
	}
	sendEvent(map[string]any{"kind": terminalKind, "result": toAPISolveResult(res)})
}

// postSolveJointStop signals an in-flight streaming solve to stop gracefully.
// The solver returns the best iterate so far; the streaming handler writes it
// back as if the loop had converged naturally and emits a "stopped" event.
func (s *Server) postSolveJointStop(w http.ResponseWriter, r *http.Request) {
	s.activeStopMu.Lock()
	ch := s.activeStop
	s.activeStopMu.Unlock()
	if ch == nil {
		writeError(w, http.StatusNotFound, "no active solve")
		return
	}
	select {
	case ch <- struct{}{}:
	default:
		// Already signaled; idempotent.
	}
	w.WriteHeader(http.StatusNoContent)
}
