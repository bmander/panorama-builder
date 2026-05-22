package solver

import "errors"

// Sentinel errors returned by Solve / SolveJointWithSeed. Declared in a
// non-gated file so the api service (built `-tags noceres`) can errors.Is
// against them — the api proxies solves to a private solver service but
// still maps the wire-error text back to these sentinels for the browser.
var (
	// ErrUnderconstrainedGauge is returned when joint mode lacks enough
	// fully-locked stations to fix translation + rotation gauge.
	ErrUnderconstrainedGauge = errors.New("solver: joint mode requires at least two stations with both lat and lng locked (translation + rotation gauge)")
	// ErrFocusNotFound is returned when Config.FocusID does not match any
	// station / control point in the problem.
	ErrFocusNotFound = errors.New("solver: focus entity not found in problem")
	// ErrInsufficientObservations is returned when the in-scope observation
	// count is insufficient to constrain even one parameter.
	ErrInsufficientObservations = errors.New("solver: too few observations to constrain the requested parameters")
)
