//go:build !noceres

// Solver entry point: builds the in-memory problem context and dispatches
// into the Ceres-Solver bridge implemented in bridge.go + bridge.cc.
package solver

// Solve runs Ceres-Solver bundle adjustment over the in-scope observations
// and free parameters of the given problem. Errors are reserved for
// problem-build failures (gauge, missing focus, FFI failure); a non-convergent
// solve is reported via Converged=false / Diverged=true on Result, not error.
func Solve(problem Problem, cfg Config) (Result, error) {
	cfg = cfg.withDefaults()

	c, err := buildContext(problem, cfg)
	if err != nil {
		return Result{}, err
	}

	return solveBridge(c)
}
