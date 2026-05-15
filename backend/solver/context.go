// Shared scaffolding for both the default (Ceres-backed) and the
// `//go:build go_solver_gn` (legacy Gauss-Newton) solver implementations.
//
// solve.go (default) and solve_legacy.go (GN fallback) each define their own
// Solve() entry point; both build a solveContext via buildContext() and use
// composeChanges() to emit the Result.Changes diff. Anything that touches
// only the GN linear-algebra path (jacobian / normal equations / live-column
// rank detection) lives in solve_legacy.go.
package solver

import (
	"errors"
	"fmt"
	"math"
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
	fdEpsK   = 1e-4
	minCosEl = 1e-6 // floor on cos(el_target) so the polar singularity stays bounded
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
	// control_point slots so any per-slot inner loop avoids re-deriving them
	// per (slot × ±eps × restore) write. Both are unread for non-CP slots,
	// so the zero defaults are fine.
	cpAxis    int
	cpMembers []int
	// regWeight (Tikhonov λ) adds a residual row of λ·value pulling the slot
	// toward zero. Zero ⇒ no regularization. Currently only used for k1/k2
	// where the parameter is weakly observable on narrow-FOV photos and the
	// solver otherwise wanders into degenerate large-magnitude minima.
	regWeight float64
}

// solveContext bundles everything the solver needs. Position state is split
// into a frozen origin (LLA + cached ECEF + local ENU basis) and a mutable
// per-entity offset (meters in the entity's *own* local tangent plane) — the
// residual then evaluates each observation in the station's own ENU, so a
// long baseline no longer inherits the gauge origin's tilt. composeChanges
// diffs the post-reconciliation result against the raw input value cached in
// problem.ControlPoints[i], so a class snap surfaces even when the solver
// itself never moved that slot.
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

	obs      []Observation // observations in scope for this mode
	slots    []slot        // free parameters (post mode + lock filtering)
	regCount int           // count of slots with regWeight > 0; cached for residual sizing

	// Per-axis CP equivalence classes from problem.CPConstraints. Empty
	// constraints yield singleton classes which collapse to the no-constraint
	// behavior. cpAxisRep[axis][cpID] → rep id; cpClassMember[axis][repID] →
	// CP indices in the class. A class is "locked" when any member has the
	// corresponding lock_est_* set; locked classes get no slot.
	cpAxisRep     [3]map[string]string
	cpClassMember [3]map[string][]int

	// Per-observation cached entity indices. Computed once in buildObsIndex
	// and passed across the FFI to bridge.cc.
	obsStationIdx []int
	obsPhotoIdx   []int
	obsCPIdx      []int
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

	c.buildObsIndex()

	return c, nil
}

// buildObsIndex caches the per-observation entity indices. Constant for the
// rest of the solve; both backends rely on it (the Ceres path passes them
// across the FFI; the GN path uses them in the Jacobian inner loop via
// buildJacobianSparsity).
func (c *solveContext) buildObsIndex() {
	c.obsStationIdx = make([]int, len(c.obs))
	c.obsPhotoIdx = make([]int, len(c.obs))
	c.obsCPIdx = make([]int, len(c.obs))
	for k, o := range c.obs {
		pIdx := c.photoIdx[o.PhotoID]
		stID := c.problem.Photos[pIdx].StationID
		c.obsStationIdx[k] = c.stationIdx[stID]
		c.obsPhotoIdx[k] = pIdx
		c.obsCPIdx[k] = c.cpIdx[o.ControlPointID]
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

// ResidualFromBearings combines predicted and target viewer-frame
// directions into the two-row angular residual the solver minimizes,
// matching the math the C++ cost functor in cost_functor.h implements.
// The az row is weighted by cos(el_target) so 1° at the horizon weighs
// more arc-length than 1° near the zenith; the floor on cos(el) keeps
// the polar singularity bounded. Exported for control_point_fits.go,
// which fits per-CP surfaces using the same residual definition.
func ResidualFromBearings(azPred, elPred, azTgt, elTgt float64) (azRow, elRow float64) {
	cosEl := math.Cos(elTgt)
	if math.Abs(cosEl) < minCosEl {
		cosEl = math.Copysign(minCosEl, cosEl)
		if cosEl == 0 {
			cosEl = minCosEl
		}
	}
	return WrapPi(azPred-azTgt) * cosEl, elPred - elTgt
}

// scopedStationLocks reports the per-axis lock state used by the Ceres
// bridge. Returns (eastLocked, northLocked, upLocked) matching the FFI
// layout. In scoped modes every station outside the optimization scope
// is fully locked; the slot-based legacy path achieves the same effect
// by simply not emitting slots for those axes.
func (c *solveContext) scopedStationLocks(s Station) (east, north, up bool) {
	switch c.cfg.Mode {
	case ModeJoint:
		return s.Locks.Lng, s.Locks.Lat, s.Locks.Alt
	case ModeSingleStation, ModeSingleControlPoint:
		return true, true, true
	}
	return true, true, true
}

// scopedPhotoLocks reports the per-field lock state for a photo under the
// configured mode. Photos outside the in-scope station (single-station
// mode) and all photos (single-CP mode) are fully locked.
func (c *solveContext) scopedPhotoLocks(p Photo) PhotoLocks {
	all := PhotoLocks{
		PhotoAz: true, PhotoTilt: true, PhotoRoll: true,
		SizeRad: true, K1: true, K2: true,
	}
	switch c.cfg.Mode {
	case ModeJoint:
		return p.Locks
	case ModeSingleStation:
		if p.StationID == c.cfg.FocusID {
			return p.Locks
		}
		return all
	}
	return all
}

// scopedCPFullyLocked reports whether cp's parameter blocks should be
// treated as constant under the configured mode (in addition to per-axis
// classAxisLock). In single-station mode no CPs move; in single-CP mode
// only the focus CP moves.
func (c *solveContext) scopedCPFullyLocked(cp ControlPoint) bool {
	switch c.cfg.Mode {
	case ModeJoint:
		return false
	case ModeSingleControlPoint:
		return cp.ID != c.cfg.FocusID
	}
	return true
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
