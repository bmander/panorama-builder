package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/bmander/panorama-builder/shared/wire"
)

// SSE solver streams. Both endpoints emit:
//
//	data: {"kind":"iter","iter":N,"rms":R,"accepted":bool}\n\n
//	data: {"kind":"done","result":{...SolveResult JSON...}}\n\n
//	data: {"kind":"stopped","result":{...SolveResult JSON...}}\n\n
//	data: {"kind":"cancelled"}\n\n
//	data: {"kind":"error","message":"..."}\n\n
//
// The api proxies these to the private solver service. Iter frames are
// forwarded verbatim (the byte shape is identical on both sides). The
// terminal `done` / `stopped` kinds are picked from wire.SolverDoneEvent's
// Aborted bit; `cancelled` fires when the api's own request context dies
// (browser disconnect) before the solver could land a terminal frame.

func (s *Server) postSolveJointStream(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	cfg, ok := parseSolveConfig(w, r)
	if !ok {
		return
	}
	cfg.Mode = wire.ModeJoint
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
	cfg.Mode = wire.ModeSingleStation
	cfg.FocusID = id
	s.streamSolve(w, r, sess, cfg)
}

func (s *Server) streamSolve(w http.ResponseWriter, r *http.Request, sess *Session, cfg wire.SolveConfigDTO) {
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

	// Iter events have the same JSON shape on both internal (solver→api) and
	// external (api→browser) wires, so we relay the raw bytes — no parse,
	// no re-marshal per iter.
	onIter := func(raw []byte) {
		fmt.Fprintf(w, "data: %s\n\n", raw)
		flusher.Flush()
	}

	res, aborted, err := s.solver.SolveStream(ctx, prob, cfg, seededCPIDs, onIter)
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
	if aborted {
		terminalKind = "stopped"
	}
	sendEvent(map[string]any{"kind": terminalKind, "result": toAPISolveResult(res)})
}

// postSolveStop forwards the stop signal to the solver service. The solver
// breaks its current iter loop at the next boundary and returns its best
// iterate via a normal `done` event with Aborted=true; the streamSolve
// handler then emits "stopped" to the browser. A 404 from the solver
// (no active solve) is treated as a benign no-op — same response either
// way.
func (s *Server) postSolveStop(w http.ResponseWriter, r *http.Request) {
	if err := s.solver.Stop(r.Context()); err != nil {
		log.Printf("solver stop: %v", err)
		writeError(w, http.StatusInternalServerError, "stop failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
