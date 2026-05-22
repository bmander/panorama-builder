package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync/atomic"

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
// postSolveStop. Only one solve is in flight at a time on this api
// instance (Server.solveMu); the api forwards the actual Ceres run to the
// private solver service via s.solver.SolveStream.

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

	// When the user-facing /api/solve/stop fires, relay it to the solver
	// service via a side-channel POST /stop. Tracking stopRequested locally
	// lets us emit the browser-facing "stopped" terminal kind while still
	// receiving a normal `done` event (with the best iterate) from the
	// solver — so writeback proceeds on the same path as a natural finish.
	//
	// solveDone closes when the main goroutine is finished with the solver
	// so the relay can exit even on natural completion (ctx isn't canceled
	// until ServeHTTP returns, and ServeHTTP can't return until the relay
	// exits — closing solveDone is what breaks that cycle). stopRequested
	// is atomic because the main goroutine reads it concurrently with the
	// relay's write window.
	var stopRequested atomic.Bool
	solveDone := make(chan struct{})
	stopRelay := make(chan struct{})
	go func() {
		defer close(stopRelay)
		select {
		case <-ctx.Done():
			return
		case <-solveDone:
			return
		case <-stopCh:
			stopRequested.Store(true)
			// Best-effort: a 404 means the solver already returned.
			if err := s.solver.Stop(context.WithoutCancel(ctx)); err != nil {
				log.Printf("solver stop relay: %v", err)
			}
		}
	}()
	defer func() {
		close(solveDone)
		<-stopRelay
	}()

	onIter := func(iter int, rms float64, accepted bool) {
		sendEvent(map[string]any{
			"kind": "iter", "iter": iter, "rms": rms, "accepted": accepted,
		})
	}

	res, err := s.solver.SolveStream(ctx, prob, cfg, seededCPIDs, onIter)
	if err != nil {
		if ctx.Err() != nil {
			sendEvent(map[string]string{"kind": "cancelled"})
			return
		}
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
	if err := s.recordSolveRMS(ctx, sess.ID, res.FinalResidualRMS); err != nil {
		log.Printf("solver rms record: %v", err)
	}

	terminalKind := "done"
	if stopRequested.Load() {
		terminalKind = "stopped"
	}
	sendEvent(map[string]any{"kind": terminalKind, "result": toAPISolveResult(res)})
}

// postSolveStop signals the in-flight streaming solve to break at the next
// iteration boundary. The handler then emits a "stopped" terminal event
// with the best iterate so far; no writeback. Shared across all streaming
// endpoints since only one solve runs at a time.
func (s *Server) postSolveStop(w http.ResponseWriter, _ *http.Request) {
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
