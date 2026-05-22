package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/bmander/panorama-builder/backend/solver"
)

// solverClient is the api side of the api ↔ solver split. Constructed once at
// boot from SOLVER_URL; called by solve_handlers.go and solve_stream.go. The
// solver service itself lives at cmd/solver/.
type solverClient struct {
	baseURL string
	http    *http.Client
}

// errSolverStreamClosed is returned by SolveStream when the SSE body ended
// without a terminal `done` or `error` event. Distinct from
// context.Canceled so the api side can tell a solver crash / proxy drop /
// truncated response apart from a user-initiated cancel.
var errSolverStreamClosed = errors.New("solver service closed stream before terminal event")

func newSolverClient(baseURL string) *solverClient {
	return &solverClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{},
	}
}

// Solve runs a synchronous solve against the solver service. Maps the three
// sentinel solver errors back from the wire so callers can errors.Is against
// solver.ErrUnderconstrainedGauge etc. exactly as if they'd called
// solver.Solve directly.
func (c *solverClient) Solve(ctx context.Context, prob solver.Problem, cfg solver.Config, seededCPIDs []string) (solver.Result, error) {
	body, err := json.Marshal(solver.SolveRequest{
		Problem:     prob,
		Config:      solver.ConfigToDTO(cfg),
		SeededCPIDs: seededCPIDs,
	})
	if err != nil {
		return solver.Result{}, fmt.Errorf("solver req marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/solve", bytes.NewReader(body))
	if err != nil {
		return solver.Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return solver.Result{}, fmt.Errorf("solver request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		return solver.Result{}, sentinelFromMessage(strings.TrimSpace(string(msg)), resp.StatusCode)
	}
	var res solver.Result
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return solver.Result{}, fmt.Errorf("solver response decode: %w", err)
	}
	return res, nil
}

// SolveStream runs a streaming solve and forwards each iter event to onIter.
// Caller cancels ctx to break the loop early — the solver service's
// ShouldStop derives from request-context cancellation, so the loop breaks
// at the next iteration boundary. Returns the final Result (best iterate
// so far if interrupted).
func (c *solverClient) SolveStream(
	ctx context.Context,
	prob solver.Problem,
	cfg solver.Config,
	seededCPIDs []string,
	onIter func(iter int, rms float64, accepted bool),
) (solver.Result, error) {
	body, err := json.Marshal(solver.SolveRequest{
		Problem:     prob,
		Config:      solver.ConfigToDTO(cfg),
		SeededCPIDs: seededCPIDs,
	})
	if err != nil {
		return solver.Result{}, fmt.Errorf("solver req marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/solve/stream", bytes.NewReader(body))
	if err != nil {
		return solver.Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	resp, err := c.http.Do(req)
	if err != nil {
		return solver.Result{}, fmt.Errorf("solver stream request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		return solver.Result{}, sentinelFromMessage(strings.TrimSpace(string(msg)), resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	// Iter payloads are small; bump the buffer to fit the terminal `done`
	// event which carries the full Result (per-entity sigma maps can run to
	// tens of KB on large problems).
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	var final solver.Result
	var solverErr error
	gotDone := false

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(line[len("data:"):])
		if payload == "" {
			continue
		}
		var head struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal([]byte(payload), &head); err != nil {
			continue
		}
		switch head.Kind {
		case solver.SolverEventIter:
			if onIter == nil {
				continue
			}
			var ev solver.SolverIterEvent
			if err := json.Unmarshal([]byte(payload), &ev); err != nil {
				continue
			}
			onIter(ev.Iter, ev.RMS, ev.Accepted)
		case solver.SolverEventDone:
			var ev solver.SolverDoneEvent
			if err := json.Unmarshal([]byte(payload), &ev); err != nil {
				return solver.Result{}, fmt.Errorf("decode done event: %w", err)
			}
			final = ev.Result
			gotDone = true
		case solver.SolverEventError:
			var ev solver.SolverErrorEvent
			if err := json.Unmarshal([]byte(payload), &ev); err != nil {
				return solver.Result{}, fmt.Errorf("decode error event: %w", err)
			}
			solverErr = sentinelFromMessage(ev.Message, http.StatusInternalServerError)
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, context.Canceled) {
		return solver.Result{}, fmt.Errorf("solver stream read: %w", err)
	}
	if solverErr != nil {
		return solver.Result{}, solverErr
	}
	if !gotDone {
		return solver.Result{}, errSolverStreamClosed
	}
	return final, nil
}

// Stop signals the in-flight solver-service streaming solve to break at the
// next iteration boundary. Best-effort: a 404 ("no active solve") is
// expected when called after the solver has already returned; treated as a
// success here so the api side doesn't need to special-case the race.
func (c *solverClient) Stop(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/stop", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("solver stop: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	msg, _ := io.ReadAll(resp.Body)
	return fmt.Errorf("solver stop: %d %s", resp.StatusCode, strings.TrimSpace(string(msg)))
}

// sentinelFromMessage maps the solver service's plain-text error body back
// to one of solver/'s sentinel errors when the message matches. Falls back
// to a generic wrapped error otherwise. Keeps errors.Is on the api side
// working for the three known cases.
func sentinelFromMessage(msg string, status int) error {
	switch {
	case strings.Contains(msg, solver.ErrUnderconstrainedGauge.Error()):
		return solver.ErrUnderconstrainedGauge
	case strings.Contains(msg, solver.ErrFocusNotFound.Error()):
		return solver.ErrFocusNotFound
	case strings.Contains(msg, solver.ErrInsufficientObservations.Error()):
		return solver.ErrInsufficientObservations
	default:
		return fmt.Errorf("solver service: %d %s", status, msg)
	}
}
