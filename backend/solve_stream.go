package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/bmander/panorama-builder/backend/solver"
)

// SSE solver streams. Both endpoints emit:
//
//	data: {"kind":"iter","iter":N,"rms":R,"accepted":bool}\n\n
//	data: {"kind":"done","result":{...SolveResult JSON...}}\n\n
//	data: {"kind":"stopped","result":{...SolveResult JSON...}}\n\n
//	data: {"kind":"cancelled"}\n\n
//	data: {"kind":"error","message":"..."}\n\n
//
// /api/solve/stop signals the current run to break gracefully — see
// postSolveStop. Only one solve is in flight at a time (Server.solveMu).
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
	s.streamSolve(w, r, sess, cfg)
}

func (s *Server) postSolveStationStream(w http.ResponseWriter, r *http.Request) {
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
	s.streamSolve(w, r, sess, cfg)
}

func (s *Server) streamSolve(w http.ResponseWriter, r *http.Request, sess *Session, cfg solver.Config) {
	// Streaming runs are user-cancellable via Cancel/Stop, so the cap mainly
	// guards against pathological non-converging configurations.
	if cfg.MaxIters == 0 {
		cfg.MaxIters = 1000
	}
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

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
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

	var res solver.Result
	if cfg.Mode == solver.ModeJoint {
		res, err = solver.SolveJointWithSeed(prob, seededCPIDs, cfg)
	} else {
		res, err = solver.Solve(prob, cfg)
	}
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

// postSolveStop signals the in-flight streaming solve to break at the next
// iteration boundary. The handler then emits a "stopped" terminal event
// with the best iterate so far; no writeback. Shared across all streaming
// endpoints since only one solve runs at a time.
func (s *Server) postSolveStop(w http.ResponseWriter, r *http.Request) {
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
