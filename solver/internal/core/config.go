package core

import "github.com/bmander/panorama-builder/shared/wire"

// Config is the solver-internal runtime configuration. It includes the
// function-pointer fields (OnIteration, ShouldStop) that can't cross the
// RPC boundary; those are wired up by the solver-binary handlers from the
// SSE writer and request context, never received from the api as data.
//
// Build a Config from a wire.SolveConfigDTO via ConfigFromDTO; the inverse
// direction doesn't exist (the api never needs a Config).
type Config struct {
	Mode     wire.Mode
	FocusID  string // station id (single-station) or CP id (single-cp); ignored for ModeJoint
	MaxIters int    // default 30
	// FunctionTol maps to Ceres options.function_tolerance — the relative
	// cost-reduction threshold per iteration. Default 1e-4 = stop when each
	// iteration reduces total cost by less than 0.01 %.
	FunctionTol      float64
	StepTol          float64 // maps to Ceres options.parameter_tolerance — relative state-vector step. Default 1e-7.
	DivergenceWindow int     // default 3 consecutive non-improving iters → revert to best
	// OnIteration, when non-nil, is called once per GN iteration after the
	// backtracking line search resolves. Synchronous — keep it cheap. Used by
	// the SSE endpoint to stream live loss progress to the browser.
	OnIteration func(iter int, residualRMS float64, accepted bool)
	// ShouldStop, when non-nil, is polled at the top of every iteration. If
	// it returns true the loop breaks gracefully — the solver still applies
	// the best iterate seen, so the caller can either write that back
	// ("stop here") or discard it ("cancel"). The caller distinguishes
	// the two outcomes externally; the solver itself only knows "should I
	// stop early."
	ShouldStop func() bool
	// KRegLambda is the Tikhonov regularization weight applied to dist_k1 /
	// dist_k2 slots. Zero ⇒ no regularization. Default 0.05 — strong enough
	// to keep weakly-observed coefficients from running away to large
	// magnitudes on narrow-FOV photos while leaving well-constrained fits
	// (lots of corner-spread observations) essentially untouched. Pass a
	// negative value to opt out entirely.
	KRegLambda float64
	// PositionRegLambda is the Tikhonov weight applied to each station's
	// ENU offset (east, north, up in meters) from its user-supplied lat/lng.
	// Each unlocked station axis adds a residual √λ·offset_m, pulling the
	// station back toward where the user placed it unless the observations
	// genuinely demand otherwise. Zero ⇒ no prior (default). Useful units:
	// λ = (σ_residual_rad / σ_position_m)². For example, λ = 1e-6 weighs a
	// 1-m drift the same as a 1-mrad bearing error; λ = 1e-4 makes 100 m of
	// drift cost about the same as a 1-rad bearing residual.
	PositionRegLambda float64
}

func (c Config) withDefaults() Config {
	if c.MaxIters == 0 {
		c.MaxIters = 30
	}
	if c.FunctionTol == 0 {
		c.FunctionTol = 1e-4
	}
	if c.StepTol == 0 {
		c.StepTol = 1e-7
	}
	if c.DivergenceWindow == 0 {
		c.DivergenceWindow = 3
	}
	if c.KRegLambda == 0 {
		c.KRegLambda = 0.05
	} else if c.KRegLambda < 0 {
		c.KRegLambda = 0
	}
	return c
}

// ConfigFromDTO builds a runtime Config from the wireable subset. The
// callback fields are left nil — the solver-binary handlers attach
// OnIteration / ShouldStop after construction, before passing into Solve.
func ConfigFromDTO(d wire.SolveConfigDTO) Config {
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
