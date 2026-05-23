package wire

// JSON RPC contract between the api binary and the private solver binary.
// The solver receives an opaque Problem + Config + (optional) SeededCPIDs
// and returns a Result. None of the types here have methods that touch
// runtime state (callbacks, channels, etc.) — pure data on the wire.

// SolveConfigDTO mirrors the solver's internal Config minus the two
// function-pointer fields (OnIteration, ShouldStop) which can't cross an
// RPC boundary. The api side wires those up locally — OnIteration is
// invoked from the SSE event parser, ShouldStop is satisfied by request-
// context cancellation. The solver side reconstructs a runtime Config
// from this DTO via solver/internal/core.ConfigFromDTO.
type SolveConfigDTO struct {
	Mode              Mode    `json:"mode"`
	FocusID           string  `json:"focus_id,omitempty"`
	MaxIters          int     `json:"max_iters,omitempty"`
	FunctionTol       float64 `json:"function_tol,omitempty"`
	StepTol           float64 `json:"step_tol,omitempty"`
	DivergenceWindow  int     `json:"divergence_window,omitempty"`
	KRegLambda        float64 `json:"k_reg_lambda,omitempty"`
	PositionRegLambda float64 `json:"position_reg_lambda,omitempty"`
}

// SolveRequest is the POST body for both /solve and /solve/stream on the
// solver service. SeededCPIDs is the list of control-point IDs that the api
// side has freshly seeded from observations — if non-empty the solver
// dispatches via SolveJointWithSeed instead of Solve.
type SolveRequest struct {
	Problem     Problem        `json:"problem"`
	Config      SolveConfigDTO `json:"config"`
	SeededCPIDs []string       `json:"seeded_cp_ids,omitempty"`
}

// SSE event kinds exchanged between the solver service and the api service.
// The api side translates these into the browser-facing kinds (e.g.
// "stopped" vs "done" depending on whether the user clicked Stop).
const (
	SolverEventIter  = "iter"
	SolverEventDone  = "done"
	SolverEventError = "error"
)

type SolverIterEvent struct {
	Kind     string  `json:"kind"`
	Iter     int     `json:"iter"`
	RMS      float64 `json:"rms"`
	Accepted bool    `json:"accepted"`
}

// SolverDoneEvent is the terminal frame of a streaming solve. Aborted is
// true iff the iter loop broke early because ShouldStop returned true
// (the api side maps this to the browser-facing "stopped" kind; false
// becomes "done"). Result carries the best iterate either way, so the
// api's writeback path is identical.
type SolverDoneEvent struct {
	Kind    string `json:"kind"`
	Aborted bool   `json:"aborted,omitempty"`
	Result  Result `json:"result"`
}

type SolverErrorEvent struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}
