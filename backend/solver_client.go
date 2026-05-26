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
	"net/url"
	"strings"

	"github.com/bmander/panorama-builder/shared/wire"
	"google.golang.org/api/idtoken"
)

// solverClient is the api side of the api ↔ solver split. Constructed once at
// boot from SOLVER_URL; called by solve_handlers.go and solve_stream.go. The
// solver service itself lives at solver/.
type solverClient struct {
	baseURL string
	http    *http.Client
}

// errSolverStreamClosed is returned by SolveStream when the SSE body ended
// without a terminal `done` or `error` event. Distinct from
// context.Canceled so the api side can tell a solver crash / proxy drop /
// truncated response apart from a user-initiated cancel.
var errSolverStreamClosed = errors.New("solver service closed stream before terminal event")

// newSolverClient constructs a solverClient that talks to baseURL. When
// baseURL points at a *.run.app host the client attaches a Google ID
// token (audience = the base URL) to every outgoing request, matching
// Cloud Run's IAM-required ingress contract. Non-run.app hosts (local
// docker-compose at http://solver:8080, plain go run, etc.) use plain
// HTTP — same dev workflow as before.
func newSolverClient(ctx context.Context, baseURL string) (*solverClient, error) {
	trimmed := strings.TrimRight(baseURL, "/")
	httpClient := &http.Client{}
	if isCloudRunHost(trimmed) {
		c, err := idtoken.NewClient(ctx, trimmed)
		if err != nil {
			return nil, fmt.Errorf("solver id-token client: %w", err)
		}
		httpClient = c
	}
	return &solverClient{baseURL: trimmed, http: httpClient}, nil
}

// isCloudRunHost reports whether rawURL's host ends in `.run.app` —
// the deployed Cloud Run service form. Used as the auth-attachment gate
// so private deployments still work without IAM in dev.
func isCloudRunHost(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	return strings.HasSuffix(u.Hostname(), ".run.app")
}

// Solve runs a synchronous solve against the solver service. Maps the three
// sentinel solver errors back from the wire so callers can errors.Is against
// wire.ErrUnderconstrainedGauge etc. exactly as if they'd called
// solver.Solve directly.
func (c *solverClient) Solve(ctx context.Context, prob wire.Problem, cfg wire.SolveConfigDTO, seededCPIDs []string) (wire.Result, error) {
	body, err := json.Marshal(wire.SolveRequest{
		Problem:     prob,
		Config:      cfg,
		SeededCPIDs: seededCPIDs,
	})
	if err != nil {
		return wire.Result{}, fmt.Errorf("solver req marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/solve", bytes.NewReader(body))
	if err != nil {
		return wire.Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return wire.Result{}, fmt.Errorf("solver request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		return wire.Result{}, sentinelFromMessage(strings.TrimSpace(string(msg)), resp.StatusCode)
	}
	var res wire.Result
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return wire.Result{}, fmt.Errorf("solver response decode: %w", err)
	}
	return res, nil
}

// SolveStream runs a streaming solve and forwards each iter event's raw
// JSON payload to onIter — the api side rebroadcasts those bytes verbatim
// to the browser, so there's no reason to parse-then-re-marshal them on
// the relay hop. Returns the final Result plus an aborted flag indicating
// the solver's loop broke early because ShouldStop returned true.
//
// Caller can break the loop early by either (a) POST /stop to the solver
// (handled by solverClient.Stop) — landing on the solver's `aborted=true`
// path — or (b) cancelling ctx, which propagates through the outgoing
// connection. In (b) the solver's ShouldStop also fires but the connection
// closes before the done event lands, so the caller sees errSolverStreamClosed.
func (c *solverClient) SolveStream(
	ctx context.Context,
	prob wire.Problem,
	cfg wire.SolveConfigDTO,
	seededCPIDs []string,
	onIter func(rawIterEvent []byte),
) (res wire.Result, aborted bool, err error) {
	body, err := json.Marshal(wire.SolveRequest{
		Problem:     prob,
		Config:      cfg,
		SeededCPIDs: seededCPIDs,
	})
	if err != nil {
		return wire.Result{}, false, fmt.Errorf("solver req marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/solve/stream", bytes.NewReader(body))
	if err != nil {
		return wire.Result{}, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	resp, err := c.http.Do(req)
	if err != nil {
		return wire.Result{}, false, fmt.Errorf("solver stream request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		return wire.Result{}, false, sentinelFromMessage(strings.TrimSpace(string(msg)), resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	// Iter payloads are small; bump the buffer to fit the terminal `done`
	// event which carries the full Result (per-entity sigma maps can run to
	// tens of KB on large problems).
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	var final wire.Result
	var doneAborted bool
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
		// Cheap kind discriminator without unmarshaling the whole payload —
		// iter events go through unparsed, only done/error are decoded.
		kind := peekKind(payload)
		switch kind {
		case wire.SolverEventIter:
			if onIter != nil {
				onIter([]byte(payload))
			}
		case wire.SolverEventDone:
			var ev wire.SolverDoneEvent
			if err := json.Unmarshal([]byte(payload), &ev); err != nil {
				return wire.Result{}, false, fmt.Errorf("decode done event: %w", err)
			}
			final = ev.Result
			doneAborted = ev.Aborted
			gotDone = true
		case wire.SolverEventError:
			var ev wire.SolverErrorEvent
			if err := json.Unmarshal([]byte(payload), &ev); err != nil {
				return wire.Result{}, false, fmt.Errorf("decode error event: %w", err)
			}
			solverErr = sentinelFromMessage(ev.Message, http.StatusInternalServerError)
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, context.Canceled) {
		return wire.Result{}, false, fmt.Errorf("solver stream read: %w", err)
	}
	if solverErr != nil {
		return wire.Result{}, false, solverErr
	}
	if !gotDone {
		return wire.Result{}, false, errSolverStreamClosed
	}
	return final, doneAborted, nil
}

// peekKind extracts the "kind" field from a JSON event payload without
// allocating a full struct decode. Returns "" on malformed input —
// callers skip unknown kinds.
func peekKind(payload string) string {
	var head struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal([]byte(payload), &head); err != nil {
		return ""
	}
	return head.Kind
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

// Warmup sends a best-effort, side-effect-free ping to the solver service so a
// scaled-to-zero instance starts spinning up ahead of an imminent solve. It
// runs no Ceres and takes no solve lock; the response status carries no
// meaning beyond "the nudge landed" — a real solve will cold-start the solver
// regardless if this missed.
func (c *solverClient) Warmup(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/warmup", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("solver warmup: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("solver warmup: status %d", resp.StatusCode)
	}
	return nil
}

// sentinelFromMessage maps the solver service's plain-text error body back
// to one of solver/'s sentinel errors when the message matches. Falls back
// to a generic wrapped error otherwise. Keeps errors.Is on the api side
// working for the three known cases.
func sentinelFromMessage(msg string, status int) error {
	switch {
	case strings.Contains(msg, wire.ErrUnderconstrainedGauge.Error()):
		return wire.ErrUnderconstrainedGauge
	case strings.Contains(msg, wire.ErrFocusNotFound.Error()):
		return wire.ErrFocusNotFound
	case strings.Contains(msg, wire.ErrInsufficientObservations.Error()):
		return wire.ErrInsufficientObservations
	default:
		return fmt.Errorf("solver service: %d %s", status, msg)
	}
}
