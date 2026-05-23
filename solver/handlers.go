package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"

	"github.com/bmander/panorama-builder/shared/wire"
	"github.com/bmander/panorama-builder/solver/internal/core"
)

// postSolve runs core.Solve or core.SolveJointWithSeed synchronously
// and returns the Result as JSON. Used by the api service for non-streaming
// solve endpoints (/api/solve/joint, /api/solve/stations/{id}, etc.).
func (s *server) postSolve(w http.ResponseWriter, r *http.Request) {
	var req wire.SolveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	cfg := core.ConfigFromDTO(req.Config)

	s.solveMu.Lock()
	defer s.solveMu.Unlock()

	// ShouldStop ties the in-Ceres loop to request-context cancellation so
	// closing the HTTP connection breaks the solver at the next iter.
	ctx := r.Context()
	cfg.ShouldStop = func() bool { return ctx.Err() != nil }

	res, err := runSolve(req, cfg)
	if err != nil {
		writeSolveError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(res); err != nil {
		log.Printf("solve: encode response: %v", err)
	}
}

// postSolveStream is the SSE variant of postSolve. Emits one `iter` event
// per Gauss-Newton iteration, then a terminal `done` event carrying the
// final Result, or an `error` event on solver failure. The api side
// translates `done` into the browser-facing "done" or "stopped" depending
// on whether the user clicked Stop.
//
// Early-stop: a concurrent POST /stop signals activeStop; the ShouldStop
// callback observes it at the next iteration boundary and the solver
// returns its best iterate so far. The `done` event still fires with that
// result so the api can do writeback.
func (s *server) postSolveStream(w http.ResponseWriter, r *http.Request) {
	var req wire.SolveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	s.solveMu.Lock()
	defer s.solveMu.Unlock()

	stopCh := make(chan struct{}, 1)
	s.activeStopMu.Lock()
	s.activeStop = stopCh
	s.activeStopMu.Unlock()
	defer func() {
		s.activeStopMu.Lock()
		s.activeStop = nil
		s.activeStopMu.Unlock()
	}()

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

	cfg := core.ConfigFromDTO(req.Config)
	ctx := r.Context()
	cfg.OnIteration = func(iter int, rms float64, accepted bool) {
		sendEvent(wire.SolverIterEvent{
			Kind:     wire.SolverEventIter,
			Iter:     iter,
			RMS:      rms,
			Accepted: accepted,
		})
	}
	// aborted tracks whether the iter loop exited because ShouldStop
	// returned true (caller-initiated /stop, or this request's context
	// cancelling). The done event carries this bit so the api side can
	// pick the right browser-facing terminal kind without keeping its
	// own per-solve state. Safe to capture as a plain bool — ShouldStop
	// runs synchronously on the cgo-calling goroutine.
	aborted := false
	cfg.ShouldStop = func() bool {
		select {
		case <-ctx.Done():
			aborted = true
			return true
		case <-stopCh:
			aborted = true
			return true
		default:
			return false
		}
	}

	res, err := runSolve(req, cfg)
	if err != nil {
		sendEvent(wire.SolverErrorEvent{Kind: wire.SolverEventError, Message: err.Error()})
		return
	}
	sendEvent(wire.SolverDoneEvent{
		Kind:    wire.SolverEventDone,
		Aborted: aborted,
		Result:  res,
	})
}

// postStop signals the in-flight streaming solve to break at the next
// iteration boundary. Mirrors the api-side semantics — once signaled, the
// solver returns its best iterate via the normal `done` event.
func (s *server) postStop(w http.ResponseWriter, _ *http.Request) {
	s.activeStopMu.Lock()
	ch := s.activeStop
	s.activeStopMu.Unlock()
	if ch == nil {
		http.Error(w, "no active solve", http.StatusNotFound)
		return
	}
	select {
	case ch <- struct{}{}:
	default:
	}
	w.WriteHeader(http.StatusNoContent)
}

// runSolve dispatches to SolveJointWithSeed when seeded CP IDs are present
// AND mode is joint; otherwise straight Solve. Same dispatch the api side
// used to do inline.
func runSolve(req wire.SolveRequest, cfg core.Config) (wire.Result, error) {
	if cfg.Mode == wire.ModeJoint {
		return core.SolveJointWithSeed(req.Problem, req.SeededCPIDs, cfg)
	}
	return core.Solve(req.Problem, cfg)
}

// writeSolveError maps the three sentinel solver errors to client-error
// status codes, everything else to 500. The api service forwards the
// status; the browser sees the same shape it does today.
func writeSolveError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, wire.ErrUnderconstrainedGauge),
		errors.Is(err, wire.ErrInsufficientObservations):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, wire.ErrFocusNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	default:
		log.Printf("solve: %v", err)
		http.Error(w, "solver failed", http.StatusInternalServerError)
	}
}
