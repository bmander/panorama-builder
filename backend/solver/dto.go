package solver

// JSON wire contract between the api service and the private solver service.
// Pure-Go types, no cgo — compiled into both binaries (the api service via
// `-tags noceres` against this package's non-gated subset; the solver
// service against the full package).
//
// The solver service has no DB or session knowledge; it receives an opaque
// Problem + Config + (optional) SeededCPIDs and returns a Result.

// SolveConfigDTO mirrors Config minus the two function-pointer fields
// (OnIteration, ShouldStop) which can't cross an RPC boundary. The api side
// wires those up locally — OnIteration is invoked from the SSE event parser,
// ShouldStop is satisfied by request-context cancellation.
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

func ConfigToDTO(c Config) SolveConfigDTO {
	return SolveConfigDTO{
		Mode:              c.Mode,
		FocusID:           c.FocusID,
		MaxIters:          c.MaxIters,
		FunctionTol:       c.FunctionTol,
		StepTol:           c.StepTol,
		DivergenceWindow:  c.DivergenceWindow,
		KRegLambda:        c.KRegLambda,
		PositionRegLambda: c.PositionRegLambda,
	}
}

func (d SolveConfigDTO) ToConfig() Config {
	return Config{
		Mode:              d.Mode,
		FocusID:           d.FocusID,
		MaxIters:          d.MaxIters,
		FunctionTol:       d.FunctionTol,
		StepTol:           d.StepTol,
		DivergenceWindow:  d.DivergenceWindow,
		KRegLambda:        d.KRegLambda,
		PositionRegLambda: d.PositionRegLambda,
	}
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

type SolverDoneEvent struct {
	Kind   string `json:"kind"`
	Result Result `json:"result"`
}

type SolverErrorEvent struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}
