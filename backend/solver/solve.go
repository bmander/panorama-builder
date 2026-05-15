//go:build !go_solver_gn

// Default solver entry point: builds the in-memory problem context and
// dispatches into the Ceres-Solver bridge implemented in bridge_ceres.go +
// bridge.cc. The legacy hand-rolled Gauss-Newton lives in solve_legacy.go,
// selected via `-tags go_solver_gn`.
package solver

// Solve runs Ceres-Solver bundle adjustment over the in-scope observations
// and free parameters of the given problem. The Config + Result + Problem
// shapes are unchanged from the legacy GN path; callers (solve_handlers.go,
// solver_writeback.go, solve_seeded.go) need no modifications.
//
// Errors are reserved for problem-build failures (gauge, missing focus, FFI
// failure); a non-convergent solve is reported via Converged=false /
// Diverged=true on Result, not error.
func Solve(problem Problem, cfg Config) (Result, error) {
	cfg = cfg.withDefaults()

	c, err := buildContext(problem, cfg)
	if err != nil {
		return Result{}, err
	}

	return solveBridge(c)
}
