// Package solver implements the Gauss-Newton bundle-adjustment solver used
// by the backend's POST /api/solve/* handlers. It is intentionally
// self-contained: no DB, no HTTP, no logging — pure math against in-memory
// inputs. Handlers assemble a Problem from the database, hand it here, and
// write the resulting Changes back inside one transaction.
package solver

import "time"

// Pose is the orientation + FOV of a photo in the panorama frame. Lat/lng
// of the camera are not part of Pose because ProjectPOI does not need them
// (it returns a direction in viewer-local coords). Lat/lng live on Station.
//
// K1, K2 are Brown-Conrady radial distortion coefficients applied in the
// normalized image-plane coordinates of the photo (zero = pure pinhole).
type Pose struct {
	PhotoAz   float64
	PhotoTilt float64
	PhotoRoll float64
	SizeRad   float64
	Aspect    float64
	K1        float64
	K2        float64
}

type StationLocks struct{ Lat, Lng, Alt bool }

type PhotoLocks struct{ PhotoAz, PhotoTilt, PhotoRoll, SizeRad, K1, K2 bool }

type CPLocks struct{ EstLat, EstLng, EstAlt bool }

type Station struct {
	ID  string
	Lat float64
	Lng float64
	Alt float64 // meters above sea level. Free slot in joint mode unless
	// Locks.Alt is set; lock_alt prevents the solver from refining it.
	Locks     StationLocks
	UpdatedAt time.Time // optimistic-concurrency token; opaque to the solver
}

type Photo struct {
	ID        string
	StationID string
	Pose      Pose
	Locks     PhotoLocks
	UpdatedAt time.Time
}

// ControlPoint estimate. EstAlt is always populated in this in-memory form;
// the DB column may be NULL ("elevation unknown"), in which case the loader
// seeds 0 here so the solver has a 3D guess to refine.
type ControlPoint struct {
	ID        string
	EstLat    float64
	EstLng    float64
	EstAlt    float64
	Locks     CPLocks
	UpdatedAt time.Time
}

type Observation struct {
	ID             string
	PhotoID        string
	ControlPointID string
	U              float64
	V              float64
}

// CPConstraint is a hard equality between two control points on one or more
// axes. The solver eliminates the shared parameter via per-axis union-find:
// every axis-class has at most one slot in the state vector, and updates to
// that slot are broadcast to every CP in the class.
//
//	"plumb" — CpAID and CpBID share est_lat AND est_lng (vertical line)
//	"level" — CpAID and CpBID share est_alt           (horizontal alignment)
type CPConstraint struct {
	CpAID, CpBID   string
	ConstraintType string
}

// Problem is the in-memory snapshot the solver mutates. After Solve returns,
// the caller diffs the snapshot against Result.Changes to know what to write.
type Problem struct {
	Stations      []Station
	Photos        []Photo
	ControlPoints []ControlPoint
	Observations  []Observation
	CPConstraints []CPConstraint
}

type Mode int

const (
	ModeJoint Mode = iota
	ModeSingleStation
	ModeSingleControlPoint
)

func (m Mode) String() string {
	switch m {
	case ModeJoint:
		return "joint"
	case ModeSingleStation:
		return "single-station"
	case ModeSingleControlPoint:
		return "single-control-point"
	default:
		return "unknown"
	}
}

type Config struct {
	Mode     Mode
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

// EntityChange is one row's before/after for the keys the solver actually
// touched. Only fields that changed by more than the per-param FD scale
// appear; locked / unchanged params are omitted.
type EntityChange struct {
	Kind   string             `json:"kind"` // "station" | "photo" | "control_point"
	ID     string             `json:"id"`
	Before map[string]float64 `json:"before"`
	After  map[string]float64 `json:"after"`
}

type Result struct {
	Iterations         int            `json:"iterations"`
	InitialResidualRMS float64        `json:"initial_residual_rms"`
	FinalResidualRMS   float64        `json:"final_residual_rms"`
	Converged          bool           `json:"converged"`
	Diverged           bool           `json:"diverged"`
	AutoLockedColumns  []string       `json:"auto_locked_columns,omitempty"`
	Changes            []EntityChange `json:"changes"`

	// PerEntitySigma is the per-parameter standard deviation at the
	// converged solution, computed via Ceres' Covariance estimator. Keyed
	// by entity ID; inner map keyed by field name (e.g. "lat", "lng",
	// "alt" on stations; "photo_az" etc. on photos; "est_lat" etc. on CPs).
	// Units: meters for positions, radians for angles, unitless for K1/K2.
	// Missing keys → axis was locked or fully unobservable. Empty map ⇒
	// covariance was not computed (e.g. solver failed before convergence).
	PerEntitySigma map[string]map[string]float64 `json:"per_entity_sigma,omitempty"`
}
