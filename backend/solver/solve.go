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
	minCosEl      = 1e-6 // floor on cos(el_target) so the polar singularity stays bounded
	rankDefRel    = 1e-9 // column-norm threshold (relative to max) to flag a free param as unobservable
	lmRel         = 1e-6 // relative LM damping: λ = lmRel * max(diag(JᵀJ))
	maxBacktracks = 5
)

// slot describes one entry in the solver's state vector. Each slot points at
// a single mutable scalar on a single entity.
type slot struct {
	kind  string // "station" | "photo" | "control_point"
	id    string
	name  string  // e.g. "lat", "photo_az", "est_alt", "east", "north", "up"
	scale float64 // FD ε; also used as the "did this change" threshold for diff emission
}

// solveContext bundles everything the inner GN loop needs. Working values
// (stationENU, photoPose, cpENU) live in arrays parallel to problem's slices
// for O(1) ID lookup via the maps.
type solveContext struct {
	cfg     Config
	problem Problem

	gaugeLat, gaugeLng float64

	stationIdx map[string]int
	photoIdx   map[string]int
	cpIdx      map[string]int

	// Mutable working state (all in ENU meters / radians).
	stationENU [][3]float64 // (east, north, up); up is read-only (no slot)
	photoPose  []Pose
	cpENU      [][3]float64 // (east, north, up)

	obs        []Observation // observations in scope for this mode
	slots      []slot        // free parameters (post mode + lock filtering)
	autoLocked []string      // slot.kind:slot.id:slot.name for columns frozen mid-solve
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
		// Nothing to solve, but not an error: the user asked for a no-op
		// (e.g. all params locked, or no observations in scope).
		return Result{Converged: true, AutoLockedColumns: c.autoLocked}, nil
	}

	state := c.readState()
	initialState := append([]float64(nil), state...)

	r := c.computeResiduals()
	initialNorm := norm(r)
	prevNorm := initialNorm
	bestState := append([]float64(nil), state...)
	bestNorm := initialNorm

	converged := false
	nonImprove := 0
	iters := 0

	for ; iters < cfg.MaxIters; iters++ {
		// Convergence by residual.
		if prevNorm < cfg.ResidualTolRad*math.Sqrt(float64(len(r))) {
			converged = true
			break
		}

		J := c.jacobian(r)

		// Detect rank-deficient columns and exclude from the linear system.
		live := c.detectLiveColumns(J)
		if len(live) == 0 {
			break
		}

		dx, ok := solveNormalEquations(J, r, live, len(c.slots))
		if !ok {
			break
		}

		// Backtracking line search.
		alpha := 1.0
		accepted := false
		var stepNorm float64
		for attempt := 0; attempt < maxBacktracks; attempt++ {
			trial := make([]float64, len(state))
			for k := range state {
				trial[k] = state[k] + alpha*dx[k]
			}
			c.applyState(trial)
			rTrial := c.computeResiduals()
			normTrial := norm(rTrial)
			if !math.IsNaN(normTrial) && !math.IsInf(normTrial, 0) && normTrial < prevNorm {
				// Re-read state in case clamping (size_rad) shrunk the step.
				state = c.readState()
				stepSq := 0.0
				for k := range dx {
					stepSq += (alpha * dx[k]) * (alpha * dx[k])
				}
				stepNorm = math.Sqrt(stepSq)
				r = rTrial
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

	gaugeStation, fullyLockedCount := pickGaugeStation(problem.Stations)

	if cfg.Mode == ModeJoint && fullyLockedCount < 2 {
		return nil, ErrUnderconstrainedGauge
	}

	switch {
	case gaugeStation != nil:
		c.gaugeLat, c.gaugeLng = gaugeStation.Lat, gaugeStation.Lng
	case cfg.Mode == ModeSingleStation:
		idx, ok := c.stationIdx[cfg.FocusID]
		if !ok {
			return nil, ErrFocusNotFound
		}
		c.gaugeLat, c.gaugeLng = problem.Stations[idx].Lat, problem.Stations[idx].Lng
	case len(problem.Stations) > 0:
		c.gaugeLat, c.gaugeLng = problem.Stations[0].Lat, problem.Stations[0].Lng
	default:
		return nil, ErrFocusNotFound
	}

	c.stationENU = make([][3]float64, len(problem.Stations))
	for i, s := range problem.Stations {
		e, n, u := LatLngAltToENU(s.Lat, s.Lng, s.Alt, c.gaugeLat, c.gaugeLng, 0)
		c.stationENU[i] = [3]float64{e, n, u}
	}
	c.photoPose = make([]Pose, len(problem.Photos))
	for i, p := range problem.Photos {
		c.photoPose[i] = p.Pose
	}
	c.cpENU = make([][3]float64, len(problem.ControlPoints))
	for i, cp := range problem.ControlPoints {
		e, n, u := LatLngAltToENU(cp.EstLat, cp.EstLng, cp.EstAlt, c.gaugeLat, c.gaugeLng, 0)
		c.cpENU[i] = [3]float64{e, n, u}
	}

	if err := c.scopeAndSlots(); err != nil {
		return nil, err
	}

	return c, nil
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
			if !cp.Locks.EstLat {
				c.slots = append(c.slots, slot{kind: "control_point", id: cp.ID, name: "north", scale: fdEpsPosM})
			}
			if !cp.Locks.EstLng {
				c.slots = append(c.slots, slot{kind: "control_point", id: cp.ID, name: "east", scale: fdEpsPosM})
			}
			if !cp.Locks.EstAlt {
				c.slots = append(c.slots, slot{kind: "control_point", id: cp.ID, name: "up", scale: fdEpsPosM})
			}
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
		if !cp.Locks.EstLat {
			c.slots = append(c.slots, slot{kind: "control_point", id: cp.ID, name: "north", scale: fdEpsPosM})
		}
		if !cp.Locks.EstLng {
			c.slots = append(c.slots, slot{kind: "control_point", id: cp.ID, name: "east", scale: fdEpsPosM})
		}
		if !cp.Locks.EstAlt {
			c.slots = append(c.slots, slot{kind: "control_point", id: cp.ID, name: "up", scale: fdEpsPosM})
		}

	default:
		return fmt.Errorf("solver: unknown mode %v", c.cfg.Mode)
	}
	return nil
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
	}
}

func (c *solveContext) writeSlot(k int, v float64) {
	s := c.slots[k]
	switch s.kind {
	case "station":
		idx := c.stationIdx[s.id]
		switch s.name {
		case "east":
			c.stationENU[idx][0] = v
		case "north":
			c.stationENU[idx][1] = v
		case "up":
			c.stationENU[idx][2] = v
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
		}
		c.photoPose[idx] = p
	case "control_point":
		idx := c.cpIdx[s.id]
		switch s.name {
		case "east":
			c.cpENU[idx][0] = v
		case "north":
			c.cpENU[idx][1] = v
		case "up":
			c.cpENU[idx][2] = v
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
			return c.stationENU[idx][0]
		case "north":
			return c.stationENU[idx][1]
		case "up":
			return c.stationENU[idx][2]
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
		}
	case "control_point":
		idx := c.cpIdx[s.id]
		switch s.name {
		case "east":
			return c.cpENU[idx][0]
		case "north":
			return c.cpENU[idx][1]
		case "up":
			return c.cpENU[idx][2]
		}
	}
	return 0
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

// computeResiduals returns the 2D angular residual vector. For each
// observation: az-row = WrapPi(az_pred − az_target) · cos(el_target);
// el-row = el_pred − el_target. The cos(el) weight on the az row makes the
// pair a true tangent-plane angular distance — 1° at the horizon weighs
// more arc-length than 1° near the zenith.
func (c *solveContext) computeResiduals() []float64 {
	r := make([]float64, 2*len(c.obs))
	for k, o := range c.obs {
		pIdx := c.photoIdx[o.PhotoID]
		pose := c.photoPose[pIdx]
		stID := c.problem.Photos[pIdx].StationID
		sIdx := c.stationIdx[stID]
		cpIdx := c.cpIdx[o.ControlPointID]

		dE := c.cpENU[cpIdx][0] - c.stationENU[sIdx][0]
		dN := c.cpENU[cpIdx][1] - c.stationENU[sIdx][1]
		dU := c.cpENU[cpIdx][2] - c.stationENU[sIdx][2]

		azPred, elPred := ProjectPOI(pose, o.U, o.V)
		azTgt, elTgt := BearingENU(dE, dN, dU)

		cosEl := math.Cos(elTgt)
		if math.Abs(cosEl) < minCosEl {
			cosEl = math.Copysign(minCosEl, cosEl)
			if cosEl == 0 {
				cosEl = minCosEl
			}
		}

		r[2*k] = WrapPi(azPred-azTgt) * cosEl
		r[2*k+1] = elPred - elTgt
	}
	return r
}

// jacobian builds the m×n finite-difference Jacobian. Central difference
// per slot, perturbing by slot.scale.
func (c *solveContext) jacobian(_ []float64) *mat.Dense {
	m := 2 * len(c.obs)
	n := len(c.slots)
	J := mat.NewDense(m, n, nil)
	for k := range c.slots {
		orig := c.readSlot(k)
		eps := c.slots[k].scale
		c.writeSlot(k, orig+eps)
		rp := c.computeResiduals()
		c.writeSlot(k, orig-eps)
		rn := c.computeResiduals()
		c.writeSlot(k, orig)
		for i := 0; i < m; i++ {
			J.Set(i, k, (rp[i]-rn[i])/(2*eps))
		}
	}
	return J
}

// detectLiveColumns returns the indices of slots whose Jacobian column carries
// real signal (L2 norm ≥ rankDefRel · max-column-norm). Columns below the
// threshold are pinned for this run and recorded in c.autoLocked.
func (c *solveContext) detectLiveColumns(J *mat.Dense) []int {
	_, n := J.Dims()
	if n == 0 {
		return nil
	}
	norms := make([]float64, n)
	maxNorm := 0.0
	for k := 0; k < n; k++ {
		s := 0.0
		col := mat.Col(nil, k, J)
		for _, v := range col {
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
// returns Δx in the full slot space (zeros on dropped columns).
func solveNormalEquations(J *mat.Dense, r []float64, live []int, n int) ([]float64, bool) {
	nn := len(live)
	if nn == 0 {
		return nil, false
	}
	m, _ := J.Dims()

	JtJ := mat.NewDense(nn, nn, nil)
	Jtr := mat.NewVecDense(nn, nil)

	for a := 0; a < nn; a++ {
		ka := live[a]
		colA := mat.Col(nil, ka, J)
		for b := a; b < nn; b++ {
			kb := live[b]
			colB := mat.Col(nil, kb, J)
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

	dx := make([]float64, n)
	for a, ka := range live {
		dx[ka] = dxLive.AtVec(a)
	}
	return dx, true
}

// composeChanges diffs the initial vs. final state and emits one
// EntityChange per touched entity, with positions converted back to lat/lng.
//
// Because the ENU projection is flat-earth and axis-aligned, the mapping is
// independent per axis: north ↔ lat, east ↔ lng, up ↔ alt. We can therefore
// translate each slot's before/after directly without consulting other slots
// of the same entity.
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

	cosLat0 := math.Cos(c.gaugeLat * math.Pi / 180)

	for k, s := range c.slots {
		bf := initial[k]
		af := final[k]
		if math.Abs(bf-af) <= s.scale {
			continue
		}
		switch s.kind {
		case "station":
			a := get(stations, s.id)
			switch s.name {
			case "north":
				a.before["lat"] = c.gaugeLat + bf/MPerDegLat
				a.after["lat"] = c.gaugeLat + af/MPerDegLat
			case "east":
				a.before["lng"] = c.gaugeLng + bf/(MPerDegLat*cosLat0)
				a.after["lng"] = c.gaugeLng + af/(MPerDegLat*cosLat0)
			case "up":
				a.before["alt"] = bf
				a.after["alt"] = af
			}
		case "photo":
			a := get(photos, s.id)
			a.before[s.name] = bf
			a.after[s.name] = af
		case "control_point":
			a := get(cps, s.id)
			switch s.name {
			case "north":
				a.before["est_lat"] = c.gaugeLat + bf/MPerDegLat
				a.after["est_lat"] = c.gaugeLat + af/MPerDegLat
			case "east":
				a.before["est_lng"] = c.gaugeLng + bf/(MPerDegLat*cosLat0)
				a.after["est_lng"] = c.gaugeLng + af/(MPerDegLat*cosLat0)
			case "up":
				a.before["est_alt"] = bf
				a.after["est_alt"] = af
			}
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
