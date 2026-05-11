package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/bmander/panorama-builder/backend/solver"
)

// postSolveJointStream is the SSE counterpart to postSolveJoint: emits one
// event per Gauss-Newton iteration and a terminal event with the final
// SolveResult.
//
// Event stream:
//
//	data: {"kind":"iter","iter":N,"rms":R,"accepted":bool}\n\n
//	data: {"kind":"done","result":{...SolveResult JSON...}}\n\n
//	data: {"kind":"stopped","result":{...SolveResult JSON...}}\n\n
//	data: {"kind":"cancelled"}\n\n
//	data: {"kind":"error","message":"..."}\n\n
func (s *Server) postSolveJointStream(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	cfg, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = solver.ModeJoint
	// User-interruptible loop; the cap mainly guards against pathological
	// non-converging configurations.
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
	prob, seededCPIDs, err := s.loadJointProblemSession(ctx, sess)
	if err != nil {
		log.Printf("solver load: %v", err)
		sendError("load failed")
		return
	}

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

	res, err := solver.SolveJointWithSeed(prob, seededCPIDs, cfg)
	if err != nil {
		sendError(err.Error())
		return
	}

	if ctx.Err() != nil {
		sendEvent(map[string]string{"kind": "cancelled"})
		return
	}

	if err := s.writebackChangesInSession(ctx, sess.ID, res.Changes); err != nil {
		log.Printf("solver writeback: %v", err)
		sendError("writeback failed")
		return
	}

	terminalKind := "done"
	if stopRequested {
		terminalKind = "stopped"
	}
	sendEvent(map[string]any{"kind": terminalKind, "result": toAPISolveResult(res)})
}

// postSolveJointStop signals the in-flight streaming solve to break at the
// next iteration boundary. The handler then emits a "stopped" terminal
// event with the best iterate so far; no writeback.
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
	}
	w.WriteHeader(http.StatusNoContent)
}
