package solver

import (
	"errors"
	"fmt"
	"math"

	"gonum.org/v1/gonum/mat"
)

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

// Per-parameter finite-difference / convergence scales. Choosing one ε per
// physical unit (radians vs meters) keeps the Jacobian well-scaled regardless
// of the problem's parameter mix; relative-LM damping (lmRel) further survives
// any residual scale mismatch.
const (
	fdEpsAngleRad = 1e-5
	fdEpsPosM     = 1e-3
	// fdEpsK perturbs Brown-Conrady k1/k2 for the numerical Jacobian. k is
	// dimensionless and typical recovered magnitudes sit in [1e-3, 5e-1];
	// 1e-4 yields a residual change of the same order as the angle FD
	// (∂residual/∂k ~ r² with r² ~ 0.01–0.25 across the image).
	fdEpsK        = 1e-4
	minCosEl      = 1e-6 // floor on cos(el_target) so the polar singularity stays bounded
	rankDefRel    = 1e-9 // column-norm threshold (relative to max) to flag a free param as unobservable
	lmRel         = 1e-6 // relative LM damping: λ = lmRel * max(diag(JᵀJ))
	maxBacktracks = 5
)

// CP axis indices, mirroring the [3]float64 layout of cpENU / stationENU
// triplets: [east, north, up]. Used by the per-axis CP-constraint union-find
// so a single index keys both the cpENU array and the per-axis class maps.
const (
	axisEast  = 0
	axisNorth = 1
	axisUp    = 2
)

// unionFind is a small string-keyed disjoint-set used to compute axis-class
// equivalence among control points. Lazy: any new key is its own root on
// first touch.
type unionFind struct {
	parent map[string]string
	rank   map[string]int
}

func newUnionFind() *unionFind {
	return &unionFind{parent: map[string]string{}, rank: map[string]int{}}
}

func (u *unionFind) find(x string) string {
	if _, ok := u.parent[x]; !ok {
		u.parent[x] = x
		return x
	}
	if u.parent[x] != x {
		u.parent[x] = u.find(u.parent[x])
	}
	return u.parent[x]
}

func (u *unionFind) union(a, b string) {
	ra, rb := u.find(a), u.find(b)
	if ra == rb {
		return
	}
	if u.rank[ra] < u.rank[rb] {
		ra, rb = rb, ra
	}
	u.parent[rb] = ra
	if u.rank[ra] == u.rank[rb] {
		u.rank[ra]++
	}
}

// slot describes one entry in the solver's state vector. Each slot points at
// a single mutable scalar on a single entity.
type slot struct {
	kind  string // "station" | "photo" | "control_point"
	id    string
	name  string  // e.g. "lat", "photo_az", "est_alt", "east", "north", "up"
	scale float64 // FD ε; also used as the "did this change" threshold for diff emission
	// cpAxis / cpMembers cache the axis index and class member CP indices for
	// control_point slots so the FD-jacobian inner loop avoids re-deriving
	// them per (slot × ±eps × restore) write. Both are unread for non-CP
	// slots, so the zero defaults are fine.
	cpAxis    int
	cpMembers []int
	// regWeight (Tikhonov λ) adds a residual row of λ·value pulling the slot
	// toward zero. Zero ⇒ no regularization. Currently only used for k1/k2
	// where the parameter is weakly observable on narrow-FOV photos and the
	// solver otherwise wanders into degenerate large-magnitude minima.
	regWeight float64
}

// solveContext bundles everything the inner GN loop needs. Position state
// is split into a frozen origin (LLA + cached ECEF + local ENU basis) and
// a mutable per-entity offset (meters in the entity's *own* local tangent
// plane) — the residual then evaluates each observation in the station's
// own ENU, so a long baseline no longer inherits the gauge origin's tilt.
// composeChanges diffs the post-reconciliation result against the raw
// input value cached in problem.ControlPoints[i], so a class snap surfaces
// even when the solver itself never moved that slot.
type solveContext struct {
	cfg     Config
	problem Problem

	stationIdx map[string]int
	photoIdx   map[string]int
	cpIdx      map[string]int

	stationOriginLLA  [][3]float64 // (lat°, lng°, alt m)
	stationOriginECEF [][3]float64
	stationBasis      []ENUBasis
	stationOffset     [][3]float64 // slot east/north/up writes here

	photoPose []Pose

	// Post-reconciliation per CP. The raw pre-reconciliation value lives on
	// problem.ControlPoints[i].{EstLat,EstLng,EstAlt} (never mutated).
	cpOriginLLA  [][3]float64
	cpOriginECEF [][3]float64
	cpBasis      []ENUBasis
	cpOffset     [][3]float64

	obs        []Observation // observations in scope for this mode
	slots      []slot        // free parameters (post mode + lock filtering)
	regCount   int           // count of slots with regWeight > 0; cached for residual sizing
	autoLocked []string      // slot.kind:slot.id:slot.name for columns frozen mid-solve

	// Per-axis CP equivalence classes from problem.CPConstraints. Empty
	// constraints yield singleton classes which collapse to the no-constraint
	// behavior. cpAxisRep[axis][cpID] → rep id; cpClassMember[axis][repID] →
	// CP indices in the class. A class is "locked" when any member has the
	// corresponding lock_est_* set; locked classes get no slot.
	cpAxisRep     [3]map[string]string
	cpClassMember [3]map[string][]int

	// Sparsity index: slotObs[k] = obs indices whose 2-row block depends on
	// slot k; slotRegRow[k] = the slot's Tikhonov row (or -1). Built once in
	// buildContext and constant for the rest of the solve, which is what
	// lets jacobian() reuse a single mat.Dense across iterations without
	// re-zeroing — every cell we don't write here, we never write.
	slotObs       [][]int
	slotRegRow    []int
	obsStationIdx []int
	obsPhotoIdx   []int
	obsCPIdx      []int

	// Per-iteration scratch reused across Solve()'s GN loop so the inner
	// loop allocates nothing. rBuf holds the accepted residual vector; the
	// line-search swaps it with rTrialBuf on accept so the previously
	// accepted vector stays valid during trial evaluation.
	rBuf      []float64
	rTrialBuf []float64
	jacMat    *mat.Dense // m × n; cells outside slotObs[k]∪{slotRegRow[k]} stay at zero forever
	colBuf    []float64  // n*m; live-column snapshot for solveNormalEquations
	colSlices [][]float64
}

// Solve runs Gauss-Newton with Levenberg-Marquardt damping over the in-scope
// observations and free parameters of the given problem.
//
// Returns Result with the diff (Changes) the caller should write back inside
// a single transaction. On Diverged the diff is empty — the caller writes
// nothing. Errors are reserved for problem-build failures (gauge, missing
// focus); a failed iteration is reported via Diverged, not error.
func Solve(problem Problem, cfg Config) (Result, error) {
	cfg = cfg.withDefaults()

	c, err := buildContext(problem, cfg)
	if err != nil {
		return Result{}, err
	}

	if len(c.obs) == 0 || len(c.slots) == 0 {
		// Nothing to solve, but not an error. Still pass through composeChanges
		// so a locked-axis class that snapped a member during reconciliation
		// surfaces as a writeback diff.
		state := c.readState()
		return Result{
			Converged:         true,
			AutoLockedColumns: c.autoLocked,
			Changes:           c.composeChanges(state, state),
		}, nil
	}

	state := c.readState()
	initialState := append([]float64(nil), state...)

	c.rBuf = c.computeResidualsInto(c.rBuf)
	r := c.rBuf
	initialNorm := norm(r)
	prevNorm := initialNorm
	bestState := append([]float64(nil), state...)
	bestNorm := initialNorm

	converged := false
	nonImprove := 0
	smallImprove := 0
	iters := 0

	for ; iters < cfg.MaxIters; iters++ {
		// External stop signal (Cancel / Stop here from the SSE handler).
		if cfg.ShouldStop != nil && cfg.ShouldStop() {
			break
		}
		// Convergence by residual.
		if prevNorm < cfg.ResidualTolRad*math.Sqrt(float64(len(r))) {
			converged = true
			break
		}

		J := c.jacobian()

		// Detect rank-deficient columns and exclude from the linear system.
		live := c.detectLiveColumns(J)
		if len(live) == 0 {
			break
		}

		dx, ok := c.solveNormalEquations(J, r, live)
		if !ok {
			break
		}

		// Backtracking line search. Reuse the trial state and trial residual
		// buffers across attempts and iterations to avoid alloc churn.
		oldNorm := prevNorm
		alpha := 1.0
		accepted := false
		var stepNorm float64
		if cap(c.rTrialBuf) < c.residualSize() {
			c.rTrialBuf = make([]float64, c.residualSize())
		}
		trial := make([]float64, len(state))
		for attempt := 0; attempt < maxBacktracks; attempt++ {
			for k := range state {
				trial[k] = state[k] + alpha*dx[k]
			}
			c.applyState(trial)
			c.rTrialBuf = c.computeResidualsInto(c.rTrialBuf)
			rTrial := c.rTrialBuf
			normTrial := norm(rTrial)
			if !math.IsNaN(normTrial) && !math.IsInf(normTrial, 0) && normTrial < prevNorm {
				// Re-read state in case clamping (size_rad) shrunk the step.
				state = c.readState()
				stepSq := 0.0
				for k := range dx {
					stepSq += (alpha * dx[k]) * (alpha * dx[k])
				}
				stepNorm = math.Sqrt(stepSq)
				// Swap r and rTrialBuf so subsequent iterations see the
				// accepted residual via rBuf and a fresh scratch lives in
				// rTrialBuf.
				c.rBuf, c.rTrialBuf = rTrial, c.rBuf
				r = c.rBuf
				prevNorm = normTrial
				accepted = true
				break
			}
			alpha *= 0.5
		}

		if cfg.OnIteration != nil {
			cfg.OnIteration(iters, rms(prevNorm, len(r)), accepted)
		}

		if !accepted {
			// Restore best-known good state and count a non-improvement.
			c.applyState(state)
			nonImprove++
			if nonImprove >= cfg.DivergenceWindow {
				break
			}
			continue
		}
		nonImprove = 0

		if prevNorm < bestNorm {
			bestNorm = prevNorm
			bestState = append(bestState[:0], state...)
		}

		if stepNorm < cfg.StepTol {
			converged = true
			break
		}

		// Relative-improvement plateau: if the residual norm shrunk by less
		// than RelImproveTol for the last RelImproveWindow accepted iters,
		// declare convergence. Catches the noise-floor plateau where the
		// absolute ResidualTolRad will never be reached.
		var relImprove float64
		if oldNorm > 0 {
			relImprove = (oldNorm - prevNorm) / oldNorm
		}
		if relImprove < cfg.RelImproveTol {
			smallImprove++
			if smallImprove >= cfg.RelImproveWindow {
				converged = true
				break
			}
		} else {
			smallImprove = 0
		}
	}

	// Always end with the best iterate applied; that's what the diff is built from.
	c.applyState(bestState)

	diverged := bestNorm >= initialNorm
	var changes []EntityChange
	if !diverged {
		changes = c.composeChanges(initialState, bestState)
	}

	return Result{
		Iterations:         iters,
		InitialResidualRMS: rms(initialNorm, len(r)),
		FinalResidualRMS:   rms(bestNorm, len(r)),
		Converged:          converged && !diverged,
		Diverged:           diverged,
		AutoLockedColumns:  c.autoLocked,
		Changes:            changes,
	}, nil
}

// buildContext indexes the problem, picks the gauge origin, validates the
// gauge for the mode, builds the working ENU state, and assembles the free
// parameter slots.
func buildContext(problem Problem, cfg Config) (*solveContext, error) {
	c := &solveContext{
		cfg:        cfg,
		problem:    problem,
		stationIdx: make(map[string]int, len(problem.Stations)),
		photoIdx:   make(map[string]int, len(problem.Photos)),
		cpIdx:      make(map[string]int, len(problem.ControlPoints)),
	}
	for i, s := range problem.Stations {
		c.stationIdx[s.ID] = i
	}
	for i, p := range problem.Photos {
		c.photoIdx[p.ID] = i
	}
	for i, cp := range problem.ControlPoints {
		c.cpIdx[cp.ID] = i
	}

	_, fullyLockedCount := pickGaugeStation(problem.Stations)

	if cfg.Mode == ModeJoint && fullyLockedCount < 2 {
		return nil, ErrUnderconstrainedGauge
	}

	if cfg.Mode == ModeSingleStation {
		if _, ok := c.stationIdx[cfg.FocusID]; !ok {
			return nil, ErrFocusNotFound
		}
	}

	c.stationOriginLLA = make([][3]float64, len(problem.Stations))
	c.stationOriginECEF = make([][3]float64, len(problem.Stations))
	c.stationBasis = make([]ENUBasis, len(problem.Stations))
	c.stationOffset = make([][3]float64, len(problem.Stations))
	for i, s := range problem.Stations {
		c.stationOriginLLA[i] = [3]float64{s.Lat, s.Lng, s.Alt}
		x, y, z := LLAToECEF(s.Lat, s.Lng, s.Alt)
		c.stationOriginECEF[i] = [3]float64{x, y, z}
		c.stationBasis[i] = LocalENUBasis(s.Lat, s.Lng)
	}

	c.photoPose = make([]Pose, len(problem.Photos))
	for i, p := range problem.Photos {
		c.photoPose[i] = p.Pose
	}

	c.cpOriginLLA = make([][3]float64, len(problem.ControlPoints))
	c.cpOffset = make([][3]float64, len(problem.ControlPoints))
	for i, cp := range problem.ControlPoints {
		c.cpOriginLLA[i] = [3]float64{cp.EstLat, cp.EstLng, cp.EstAlt}
	}

	c.buildCPAxisClasses()
	c.reconcileCPClasses()

	// Reconciliation may have snapped CP origins; derive ECEF + basis last.
	c.cpOriginECEF = make([][3]float64, len(problem.ControlPoints))
	c.cpBasis = make([]ENUBasis, len(problem.ControlPoints))
	for i, lla := range c.cpOriginLLA {
		x, y, z := LLAToECEF(lla[0], lla[1], lla[2])
		c.cpOriginECEF[i] = [3]float64{x, y, z}
		c.cpBasis[i] = LocalENUBasis(lla[0], lla[1])
	}

	if err := c.scopeAndSlots(); err != nil {
		return nil, err
	}
	for _, s := range c.slots {
		if s.regWeight > 0 {
			c.regCount++
		}
	}

	c.buildSparsity()

	return c, nil
}

// buildSparsity precomputes, for each slot, the residual rows it touches.
// Run once after slots and obs are finalized; the patterns are static for the
// rest of the solve.
func (c *solveContext) buildSparsity() {
	c.obsStationIdx = make([]int, len(c.obs))
	c.obsPhotoIdx = make([]int, len(c.obs))
	c.obsCPIdx = make([]int, len(c.obs))

	obsByStation := make(map[string][]int, len(c.stationIdx))
	obsByPhoto := make(map[string][]int, len(c.photoIdx))
	obsByCP := make(map[string][]int, len(c.cpIdx))
	for k, o := range c.obs {
		pIdx := c.photoIdx[o.PhotoID]
		stID := c.problem.Photos[pIdx].StationID
		c.obsStationIdx[k] = c.stationIdx[stID]
		c.obsPhotoIdx[k] = pIdx
		c.obsCPIdx[k] = c.cpIdx[o.ControlPointID]
		obsByPhoto[o.PhotoID] = append(obsByPhoto[o.PhotoID], k)
		obsByCP[o.ControlPointID] = append(obsByCP[o.ControlPointID], k)
		obsByStation[stID] = append(obsByStation[stID], k)
	}

	c.slotObs = make([][]int, len(c.slots))
	c.slotRegRow = make([]int, len(c.slots))
	regRow := 2 * len(c.obs)
	for k, s := range c.slots {
		switch s.kind {
		case "station":
			c.slotObs[k] = obsByStation[s.id]
		case "photo":
			c.slotObs[k] = obsByPhoto[s.id]
		case "control_point":
			// A CP slot writes every class member on its axis, so its
			// jacobian column must cover the obs of every member.
			if len(s.cpMembers) <= 1 {
				c.slotObs[k] = obsByCP[s.id]
			} else {
				var combined []int
				for _, idx := range s.cpMembers {
					combined = append(combined, obsByCP[c.problem.ControlPoints[idx].ID]...)
				}
				c.slotObs[k] = combined
			}
		}
		if s.regWeight > 0 {
			c.slotRegRow[k] = regRow
			regRow++
		} else {
			c.slotRegRow[k] = -1
		}
	}

	m := c.residualSize()
	n := len(c.slots)
	if m > 0 && n > 0 {
		c.jacMat = mat.NewDense(m, n, nil)
		c.colBuf = make([]float64, n*m)
		c.colSlices = make([][]float64, n)
	}
}

// buildCPAxisClasses populates cpAxisRep / cpClassMember from
// problem.CPConstraints. Every CP starts as its own singleton on every axis;
// each constraint unions both endpoints on the relevant axes.
//
// Fast path: with zero constraints (the common case) every class is a
// singleton, so skip the union-find allocation and seed each CP as its own
// rep directly.
func (c *solveContext) buildCPAxisClasses() {
	n := len(c.problem.ControlPoints)
	for a := 0; a < 3; a++ {
		c.cpAxisRep[a] = make(map[string]string, n)
		c.cpClassMember[a] = make(map[string][]int, n)
	}
	if len(c.problem.CPConstraints) == 0 {
		for i, cp := range c.problem.ControlPoints {
			for a := 0; a < 3; a++ {
				c.cpAxisRep[a][cp.ID] = cp.ID
				c.cpClassMember[a][cp.ID] = []int{i}
			}
		}
		return
	}

	ufs := [3]*unionFind{newUnionFind(), newUnionFind(), newUnionFind()}
	for _, k := range c.problem.CPConstraints {
		// Skip constraints whose endpoints aren't both loaded — single-station
		// and single-CP modes intentionally restrict the active set, and a
		// half-loaded constraint has no anchor.
		if _, ok := c.cpIdx[k.CpAID]; !ok {
			continue
		}
		if _, ok := c.cpIdx[k.CpBID]; !ok {
			continue
		}
		switch k.ConstraintType {
		case "plumb":
			ufs[axisEast].union(k.CpAID, k.CpBID)
			ufs[axisNorth].union(k.CpAID, k.CpBID)
		case "level":
			ufs[axisUp].union(k.CpAID, k.CpBID)
		default:
			// Unknown type slipped past the API validator; treat as no-op
			// rather than silently union on the wrong axes.
			continue
		}
	}
	for a := 0; a < 3; a++ {
		for i, cp := range c.problem.ControlPoints {
			rep := ufs[a].find(cp.ID)
			c.cpAxisRep[a][cp.ID] = rep
			c.cpClassMember[a][rep] = append(c.cpClassMember[a][rep], i)
		}
	}
}

// classAxisLock returns (locked, lockedValue) for the axis class containing
// the rep CP id. Locked when any member has the corresponding axis lock;
// the returned value is the locked member's geodetic component on that
// axis (lat for axisNorth, lng for axisEast, alt for axisUp), taken from
// the input problem.
func (c *solveContext) classAxisLock(axis int, repID string) (bool, float64) {
	members := c.cpClassMember[axis][repID]
	for _, idx := range members {
		cp := c.problem.ControlPoints[idx]
		switch axis {
		case axisNorth:
			if cp.Locks.EstLat {
				return true, cp.EstLat
			}
		case axisEast:
			if cp.Locks.EstLng {
				return true, cp.EstLng
			}
		case axisUp:
			if cp.Locks.EstAlt {
				return true, cp.EstAlt
			}
		}
	}
	return false, 0
}

// llaIdxFor maps an axisEast/axisNorth/axisUp class index to the
// corresponding [lat,lng,alt] component in cpOriginLLA / cpProblemLLA.
func llaIdxFor(axis int) int {
	switch axis {
	case axisNorth:
		return 0 // lat
	case axisEast:
		return 1 // lng
	case axisUp:
		return 2 // alt
	}
	return -1
}

// reconcileCPClasses snaps every class member's origin LLA on each
// constrained axis to a single chosen value (the locked member's, else the
// rep's). After reconciliation the slot offset (which broadcasts across
// class members) gives identical effective positions on the constrained
// axis for all members. Without this step, two members of a free class
// with different starting altitudes would enter the solver with different
// origin LLAs but a common offset — and silently disagree.
func (c *solveContext) reconcileCPClasses() {
	for a := 0; a < 3; a++ {
		seen := map[string]struct{}{}
		llaIdx := llaIdxFor(a)
		for _, cp := range c.problem.ControlPoints {
			rep := c.cpAxisRep[a][cp.ID]
			if _, done := seen[rep]; done {
				continue
			}
			seen[rep] = struct{}{}
			members := c.cpClassMember[a][rep]
			if len(members) <= 1 {
				continue
			}
			locked, lockedVal := c.classAxisLock(a, rep)
			var v float64
			if locked {
				v = lockedVal
			} else {
				v = c.cpOriginLLA[c.cpIdx[rep]][llaIdx]
			}
			for _, idx := range members {
				c.cpOriginLLA[idx][llaIdx] = v
			}
		}
	}
}

func pickGaugeStation(stations []Station) (*Station, int) {
	var first *Station
	count := 0
	for i := range stations {
		if stations[i].Locks.Lat && stations[i].Locks.Lng {
			if first == nil {
				first = &stations[i]
			}
			count++
		}
	}
	return first, count
}

// scopeAndSlots filters observations + free parameters by the configured
// mode. ModeSingleStation locks all stations and CPs; ModeSingleControlPoint
// locks everything except the focus CP.
func (c *solveContext) scopeAndSlots() error {
	switch c.cfg.Mode {
	case ModeJoint:
		c.obs = append([]Observation(nil), c.problem.Observations...)
		for _, s := range c.problem.Stations {
			if !s.Locks.Lat {
				c.slots = append(c.slots, slot{kind: "station", id: s.ID, name: "north", scale: fdEpsPosM})
			}
			if !s.Locks.Lng {
				c.slots = append(c.slots, slot{kind: "station", id: s.ID, name: "east", scale: fdEpsPosM})
			}
			if !s.Locks.Alt {
				c.slots = append(c.slots, slot{kind: "station", id: s.ID, name: "up", scale: fdEpsPosM})
			}
		}
		c.appendPhotoSlots(c.problem.Photos)
		for _, cp := range c.problem.ControlPoints {
			c.appendCPSlot(cp, axisNorth, "north")
			c.appendCPSlot(cp, axisEast, "east")
			c.appendCPSlot(cp, axisUp, "up")
		}

	case ModeSingleStation:
		if _, ok := c.stationIdx[c.cfg.FocusID]; !ok {
			return ErrFocusNotFound
		}
		// Only photos belonging to the focus station, and only their observations.
		photoIDs := map[string]bool{}
		var scopedPhotos []Photo
		for _, p := range c.problem.Photos {
			if p.StationID == c.cfg.FocusID {
				photoIDs[p.ID] = true
				scopedPhotos = append(scopedPhotos, p)
			}
		}
		for _, o := range c.problem.Observations {
			if photoIDs[o.PhotoID] {
				c.obs = append(c.obs, o)
			}
		}
		c.appendPhotoSlots(scopedPhotos)

	case ModeSingleControlPoint:
		cpIdx, ok := c.cpIdx[c.cfg.FocusID]
		if !ok {
			return ErrFocusNotFound
		}
		cp := c.problem.ControlPoints[cpIdx]
		for _, o := range c.problem.Observations {
			if o.ControlPointID == c.cfg.FocusID {
				c.obs = append(c.obs, o)
			}
		}
		if len(c.obs) < 2 {
			return ErrInsufficientObservations
		}
		c.appendCPSlot(cp, axisNorth, "north")
		c.appendCPSlot(cp, axisEast, "east")
		c.appendCPSlot(cp, axisUp, "up")

	default:
		return fmt.Errorf("solver: unknown mode %v", c.cfg.Mode)
	}
	return nil
}

// appendCPSlot emits one slot for the (axis-class containing cp, axis) pair,
// but only when cp is the rep of that class and the class is free.
func (c *solveContext) appendCPSlot(cp ControlPoint, axis int, name string) {
	if c.cpAxisRep[axis][cp.ID] != cp.ID {
		return
	}
	if locked, _ := c.classAxisLock(axis, cp.ID); locked {
		return
	}
	c.slots = append(c.slots, slot{
		kind: "control_point", id: cp.ID, name: name, scale: fdEpsPosM,
		cpAxis: axis, cpMembers: c.cpClassMember[axis][cp.ID],
	})
}

func (c *solveContext) appendPhotoSlots(photos []Photo) {
	for _, p := range photos {
		if !p.Locks.PhotoAz {
			c.slots = append(c.slots, slot{kind: "photo", id: p.ID, name: "photo_az", scale: fdEpsAngleRad})
		}
		if !p.Locks.PhotoTilt {
			c.slots = append(c.slots, slot{kind: "photo", id: p.ID, name: "photo_tilt", scale: fdEpsAngleRad})
		}
		if !p.Locks.PhotoRoll {
			c.slots = append(c.slots, slot{kind: "photo", id: p.ID, name: "photo_roll", scale: fdEpsAngleRad})
		}
		if !p.Locks.SizeRad {
			c.slots = append(c.slots, slot{kind: "photo", id: p.ID, name: "size_rad", scale: fdEpsAngleRad})
		}
		if !p.Locks.K1 {
			c.slots = append(c.slots, slot{kind: "photo", id: p.ID, name: "dist_k1", scale: fdEpsK, regWeight: c.cfg.KRegLambda})
		}
		if !p.Locks.K2 {
			c.slots = append(c.slots, slot{kind: "photo", id: p.ID, name: "dist_k2", scale: fdEpsK, regWeight: c.cfg.KRegLambda})
		}
	}
}

func (c *solveContext) writeSlot(k int, v float64) {
	s := c.slots[k]
	switch s.kind {
	case "station":
		idx := c.stationIdx[s.id]
		switch s.name {
		case "east":
			c.stationOffset[idx][axisEast] = v
		case "north":
			c.stationOffset[idx][axisNorth] = v
		case "up":
			c.stationOffset[idx][axisUp] = v
		}
	case "photo":
		idx := c.photoIdx[s.id]
		p := c.photoPose[idx]
		switch s.name {
		case "photo_az":
			p.PhotoAz = v
		case "photo_tilt":
			p.PhotoTilt = v
		case "photo_roll":
			p.PhotoRoll = v
		case "size_rad":
			p.SizeRad = clampSize(v)
		case "dist_k1":
			p.K1 = v
		case "dist_k2":
			p.K2 = v
		}
		c.photoPose[idx] = p
	case "control_point":
		for _, idx := range s.cpMembers {
			c.cpOffset[idx][s.cpAxis] = v
		}
	}
}

func (c *solveContext) readSlot(k int) float64 {
	s := c.slots[k]
	switch s.kind {
	case "station":
		idx := c.stationIdx[s.id]
		switch s.name {
		case "east":
			return c.stationOffset[idx][axisEast]
		case "north":
			return c.stationOffset[idx][axisNorth]
		case "up":
			return c.stationOffset[idx][axisUp]
		}
	case "photo":
		idx := c.photoIdx[s.id]
		p := c.photoPose[idx]
		switch s.name {
		case "photo_az":
			return p.PhotoAz
		case "photo_tilt":
			return p.PhotoTilt
		case "photo_roll":
			return p.PhotoRoll
		case "size_rad":
			return p.SizeRad
		case "dist_k1":
			return p.K1
		case "dist_k2":
			return p.K2
		}
	case "control_point":
		idx := c.cpIdx[s.id]
		switch s.name {
		case "east":
			return c.cpOffset[idx][axisEast]
		case "north":
			return c.cpOffset[idx][axisNorth]
		case "up":
			return c.cpOffset[idx][axisUp]
		}
	}
	return 0
}

// currentECEF returns origin + offset·basis. The zero-offset shortcut
// matters at solve start (every entity has offset 0) and for any locked
// entity (offset stays 0 throughout).
func currentECEF(origin [3]float64, basis ENUBasis, off [3]float64) [3]float64 {
	if off == ([3]float64{}) {
		return origin
	}
	x, y, z := ApplyOffsetECEF(origin, basis, off[axisEast], off[axisNorth], off[axisUp])
	return [3]float64{x, y, z}
}

func (c *solveContext) readState() []float64 {
	out := make([]float64, len(c.slots))
	for k := range c.slots {
		out[k] = c.readSlot(k)
	}
	return out
}

func (c *solveContext) applyState(state []float64) {
	for k, v := range state {
		c.writeSlot(k, v)
	}
}

// computeOneObsResidual returns the (az, el) residual rows for a single
// observation. Uses cached entity indices (obsStationIdx/PhotoIdx/CPIdx) so
// the inner FD loop never touches the per-ID maps.
//
// The CP-relative position is computed in the *station's* own local ENU:
// reconstruct each entity's effective ECEF (origin + slot offset · basis),
// take the ECEF delta, project into the station's basis, and add the
// k=0.14 atmospheric refraction correction. The geometric Earth-curvature
// drop is implicit in the ECEF math; only refraction needs an explicit term.
//
// az-row = WrapPi(az_pred − az_target) · cos(el_target),
// el-row = el_pred − el_target. The cos(el) weight makes 1° at the horizon
// weigh more arc-length than 1° near the zenith.
func (c *solveContext) computeOneObsResidual(k int) (float64, float64) {
	o := c.obs[k]
	pIdx := c.obsPhotoIdx[k]
	pose := c.photoPose[pIdx]
	sIdx := c.obsStationIdx[k]
	cpIdx := c.obsCPIdx[k]

	sECEF := currentECEF(c.stationOriginECEF[sIdx], c.stationBasis[sIdx], c.stationOffset[sIdx])
	cECEF := currentECEF(c.cpOriginECEF[cpIdx], c.cpBasis[cpIdx], c.cpOffset[cpIdx])
	basis := c.stationBasis[sIdx]
	dE, dN, dU := ProjectECEFDeltaToLocalENU(
		cECEF[0]-sECEF[0], cECEF[1]-sECEF[1], cECEF[2]-sECEF[2], basis)
	dU += RefractionK * (dE*dE + dN*dN) / (2 * basis.Rlocal)

	azPred, elPred := ProjectPOI(pose, o.U, o.V)
	azTgt, elTgt := BearingENU(dE, dN, dU)

	cosEl := math.Cos(elTgt)
	if math.Abs(cosEl) < minCosEl {
		cosEl = math.Copysign(minCosEl, cosEl)
		if cosEl == 0 {
			cosEl = minCosEl
		}
	}

	return WrapPi(azPred-azTgt) * cosEl, elPred - elTgt
}

// residualSize returns the number of residual rows: 2 angular rows per
// observation plus one Tikhonov row per regularized slot.
func (c *solveContext) residualSize() int { return 2*len(c.obs) + c.regCount }

// computeResidualsInto writes the residual vector into dst (resizing if
// needed). Returns the populated slice. See computeOneObsResidual for the
// per-observation rows; reg rows are λ·p, pulling each regularized slot
// toward zero (equivalent to an N(0, 1/λ) Gaussian prior).
func (c *solveContext) computeResidualsInto(dst []float64) []float64 {
	m := c.residualSize()
	if cap(dst) < m {
		dst = make([]float64, m)
	} else {
		dst = dst[:m]
	}
	for k := range c.obs {
		az, el := c.computeOneObsResidual(k)
		dst[2*k] = az
		dst[2*k+1] = el
	}
	regIdx := 2 * len(c.obs)
	for k, s := range c.slots {
		if s.regWeight == 0 {
			continue
		}
		dst[regIdx] = s.regWeight * c.readSlot(k)
		regIdx++
	}
	return dst
}

// jacobian builds the m×n finite-difference Jacobian using central
// differences. Sparsity makes this cheap: each slot only touches the rows
// listed in slotObs[k] (plus its own reg row, if any), so untouched cells
// in c.jacMat stay at the zero they were initialized to in buildSparsity
// — that is the invariant that makes the per-iteration reuse safe.
func (c *solveContext) jacobian() *mat.Dense {
	J := c.jacMat
	raw := J.RawMatrix()
	data := raw.Data
	stride := raw.Stride

	for k := range c.slots {
		affected := c.slotObs[k]
		regRow := c.slotRegRow[k]
		regWeight := c.slots[k].regWeight
		eps := c.slots[k].scale
		inv2eps := 1.0 / (2 * eps)
		orig := c.readSlot(k)

		c.writeSlot(k, orig+eps)
		for _, obsIdx := range affected {
			az, el := c.computeOneObsResidual(obsIdx)
			data[(2*obsIdx)*stride+k] = az
			data[(2*obsIdx+1)*stride+k] = el
		}

		c.writeSlot(k, orig-eps)
		for _, obsIdx := range affected {
			az, el := c.computeOneObsResidual(obsIdx)
			i0 := (2*obsIdx)*stride + k
			i1 := (2*obsIdx+1)*stride + k
			data[i0] = (data[i0] - az) * inv2eps
			data[i1] = (data[i1] - el) * inv2eps
		}
		// Reg-row derivative is exact: r_reg = regWeight·param ⇒ ∂/∂param =
		// regWeight. Reg slots (k1/k2) aren't subject to clampSize, so the FD
		// column is identically the analytic value.
		if regRow >= 0 {
			data[regRow*stride+k] = regWeight
		}

		c.writeSlot(k, orig)
	}
	return J
}

// detectLiveColumns returns the indices of slots whose Jacobian column carries
// real signal (L2 norm ≥ rankDefRel · max-column-norm). Columns below the
// threshold are pinned for this run and recorded in c.autoLocked.
func (c *solveContext) detectLiveColumns(J *mat.Dense) []int {
	m, n := J.Dims()
	if n == 0 {
		return nil
	}
	raw := J.RawMatrix()
	data, stride := raw.Data, raw.Stride
	norms := make([]float64, n)
	maxNorm := 0.0
	for k := 0; k < n; k++ {
		s := 0.0
		for i := 0; i < m; i++ {
			v := data[i*stride+k]
			s += v * v
		}
		norms[k] = math.Sqrt(s)
		if norms[k] > maxNorm {
			maxNorm = norms[k]
		}
	}
	threshold := maxNorm * rankDefRel
	var live []int
	for k := 0; k < n; k++ {
		if norms[k] < threshold {
			tag := fmt.Sprintf("%s:%s:%s", c.slots[k].kind, c.slots[k].id, c.slots[k].name)
			if !contains(c.autoLocked, tag) {
				c.autoLocked = append(c.autoLocked, tag)
			}
			continue
		}
		live = append(live, k)
	}
	return live
}

// solveNormalEquations forms (JᵀJ + λI) Δx = −Jᵀr on the live subset and
// returns Δx in the full slot space (zeros on dropped columns). Snapshots
// each live column into a contiguous slice (reusing c.colBuf / c.colSlices
// across iterations) so the JᵀJ accumulation is a flat dot product rather
// than nn²/2 mat.Col allocations.
func (c *solveContext) solveNormalEquations(J *mat.Dense, r []float64, live []int) ([]float64, bool) {
	nn := len(live)
	if nn == 0 {
		return nil, false
	}
	m, _ := J.Dims()
	raw := J.RawMatrix()
	data, stride := raw.Data, raw.Stride

	cols := c.colSlices[:nn]
	for a, ka := range live {
		col := c.colBuf[a*m : (a+1)*m]
		for i := 0; i < m; i++ {
			col[i] = data[i*stride+ka]
		}
		cols[a] = col
	}

	JtJ := mat.NewDense(nn, nn, nil)
	Jtr := mat.NewVecDense(nn, nil)

	for a := 0; a < nn; a++ {
		colA := cols[a]
		for b := a; b < nn; b++ {
			colB := cols[b]
			s := 0.0
			for i := 0; i < m; i++ {
				s += colA[i] * colB[i]
			}
			JtJ.Set(a, b, s)
			if a != b {
				JtJ.Set(b, a, s)
			}
		}
		s := 0.0
		for i := 0; i < m; i++ {
			s += colA[i] * r[i]
		}
		Jtr.SetVec(a, -s)
	}

	maxDiag := 0.0
	for a := 0; a < nn; a++ {
		if v := JtJ.At(a, a); v > maxDiag {
			maxDiag = v
		}
	}
	lambda := lmRel * maxDiag
	if lambda == 0 {
		lambda = lmRel
	}
	for a := 0; a < nn; a++ {
		JtJ.Set(a, a, JtJ.At(a, a)+lambda)
	}

	var dxLive mat.VecDense
	if err := dxLive.SolveVec(JtJ, Jtr); err != nil {
		return nil, false
	}

	dx := make([]float64, len(c.slots))
	for a, ka := range live {
		dx[ka] = dxLive.AtVec(a)
	}
	return dx, true
}

// composeChanges emits one EntityChange per entity whose effective LLA (or
// photo intrinsic) moved by more than the FD scale. Photo slots use the raw
// initial/final slot values; station and CP positions are reconstructed
// from origin + slot-offset and round-tripped through ECEFToLLA so the
// emitted lat/lng/alt reflect the per-station tangent-plane semantics
// (and the CP "before" column carries the pre-reconciliation problem
// value, so a snap surfaces even when the solver itself didn't move that
// member's slot).
func (c *solveContext) composeChanges(initial, final []float64) []EntityChange {
	type acc struct {
		before map[string]float64
		after  map[string]float64
	}
	get := func(m map[string]*acc, id string) *acc {
		a, ok := m[id]
		if !ok {
			a = &acc{before: map[string]float64{}, after: map[string]float64{}}
			m[id] = a
		}
		return a
	}
	stations := map[string]*acc{}
	photos := map[string]*acc{}
	cps := map[string]*acc{}

	// Photo slots: scalar before/after, no LLA round-trip.
	for k, s := range c.slots {
		if s.kind != "photo" {
			continue
		}
		bf := initial[k]
		af := final[k]
		if math.Abs(bf-af) <= s.scale {
			continue
		}
		a := get(photos, s.id)
		a.before[s.name] = bf
		a.after[s.name] = af
	}

	// Stations: round-trip current ECEF to LLA, diff against problem input.
	for i, st := range c.problem.Stations {
		off := c.stationOffset[i]
		if off == ([3]float64{}) {
			continue
		}
		ecef := currentECEF(c.stationOriginECEF[i], c.stationBasis[i], off)
		afterLat, afterLng, afterAlt := ECEFToLLA(ecef[0], ecef[1], ecef[2])
		a := get(stations, st.ID)
		emitLLADiff(a.before, a.after, "",
			[3]float64{st.Lat, st.Lng, st.Alt},
			[3]float64{afterLat, afterLng, afterAlt})
		if len(a.after) == 0 {
			delete(stations, st.ID)
		}
	}

	// CPs: per-axis "after" value is sourced from the rep of each CP's axis
	// class so members on a shared axis emit bit-exact equal output. Locked
	// classes shortcut to the rep's origin LLA (already snapped to the
	// user's value in reconcileCPClasses), bypassing ECEF round-trip
	// roundoff (~µm). lockedRep[axis][rep] memoizes classAxisLock so
	// emission is O(n_CP·3) hash lookups instead of O(n_CP·n_member·3).
	afterLLA := make([][3]float64, len(c.problem.ControlPoints))
	for i := range c.problem.ControlPoints {
		// Unmoved CPs (locked or out-of-scope) keep their post-reconciliation
		// origin LLA verbatim, skipping the ECEF round-trip and its ~µm noise.
		if c.cpOffset[i] == ([3]float64{}) {
			afterLLA[i] = c.cpOriginLLA[i]
			continue
		}
		ecef := currentECEF(c.cpOriginECEF[i], c.cpBasis[i], c.cpOffset[i])
		lat, lng, alt := ECEFToLLA(ecef[0], ecef[1], ecef[2])
		afterLLA[i] = [3]float64{lat, lng, alt}
	}
	var lockedRep [3]map[string]bool
	for axis := 0; axis < 3; axis++ {
		lockedRep[axis] = make(map[string]bool, len(c.cpClassMember[axis]))
		for repID := range c.cpClassMember[axis] {
			locked, _ := c.classAxisLock(axis, repID)
			lockedRep[axis][repID] = locked
		}
	}
	cpAxisAfter := func(cp ControlPoint, axis int) float64 {
		repID := c.cpAxisRep[axis][cp.ID]
		repIdx := c.cpIdx[repID]
		if lockedRep[axis][repID] {
			return c.cpOriginLLA[repIdx][llaIdxFor(axis)]
		}
		return afterLLA[repIdx][llaIdxFor(axis)]
	}
	for _, cp := range c.problem.ControlPoints {
		afterLat := cpAxisAfter(cp, axisNorth)
		afterLng := cpAxisAfter(cp, axisEast)
		afterAlt := cpAxisAfter(cp, axisUp)
		a := get(cps, cp.ID)
		emitLLADiff(a.before, a.after, "est_",
			[3]float64{cp.EstLat, cp.EstLng, cp.EstAlt},
			[3]float64{afterLat, afterLng, afterAlt})
		if len(a.after) == 0 {
			delete(cps, cp.ID)
		}
	}

	var out []EntityChange
	for id, a := range stations {
		out = append(out, EntityChange{Kind: "station", ID: id, Before: a.before, After: a.after})
	}
	for id, a := range photos {
		out = append(out, EntityChange{Kind: "photo", ID: id, Before: a.before, After: a.after})
	}
	for id, a := range cps {
		out = append(out, EntityChange{Kind: "control_point", ID: id, Before: a.before, After: a.after})
	}
	return out
}

// emitLLADiff writes before/after entries (`prefix`+lat|lng|alt) for any
// axis whose change exceeds fdEpsPosM in linear meters at the entity's own
// latitude. Used by composeChanges (prefix `""` for stations, `"est_"` for
// CPs) and by mergeSeededCPChanges.
func emitLLADiff(
	before, after map[string]float64,
	prefix string,
	beforeLLA, afterLLA [3]float64,
) {
	if math.Abs(afterLLA[0]-beforeLLA[0])*MPerDegLat > fdEpsPosM {
		before[prefix+"lat"] = beforeLLA[0]
		after[prefix+"lat"] = afterLLA[0]
	}
	cosLat := math.Cos(beforeLLA[0] * math.Pi / 180)
	if math.Abs(afterLLA[1]-beforeLLA[1])*MPerDegLat*cosLat > fdEpsPosM {
		before[prefix+"lng"] = beforeLLA[1]
		after[prefix+"lng"] = afterLLA[1]
	}
	if math.Abs(afterLLA[2]-beforeLLA[2]) > fdEpsPosM {
		before[prefix+"alt"] = beforeLLA[2]
		after[prefix+"alt"] = afterLLA[2]
	}
}

func clampSize(v float64) float64 {
	const lo = 2 * math.Pi / 180 // 2°
	const hi = math.Pi * 0.95
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func norm(r []float64) float64 {
	s := 0.0
	for _, v := range r {
		s += v * v
	}
	return math.Sqrt(s)
}

func rms(n float64, m int) float64 {
	if m == 0 {
		return 0
	}
	return n / math.Sqrt(float64(m))
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
