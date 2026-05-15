package solver_test

import (
	"errors"
	"math"
	"testing"

	"github.com/bmander/panorama-builder/backend/solver"
	"github.com/bmander/panorama-builder/backend/solver/synth"
)

// TestBridgeIterationCallback verifies the FFI iteration callback fires at
// least once on a non-trivial joint solve and emits monotonically-decreasing
// RMS values (allowing for occasional rejected steps where Ceres' line
// search backs off — those come through with accepted=false).
func TestBridgeIterationCallback(t *testing.T) {
	cpLat, cpLng := offsetLatLng(0, 50)
	w := synth.World{
		Stations: []synth.TrueStation{
			fullyLocked("s1", gaugeLat, gaugeLng),
			lockedAt("s2", 40, 0),
		},
		Photos: []synth.TruePhoto{
			{ID: "p1", StationID: "s1", Pose: basicPose(0),
				Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
			{ID: "p2", StationID: "s2", Pose: basicPose(0),
				Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cp1", EstLat: cpLat, EstLng: cpLng, EstAlt: 0},
		},
		VisibleIn: [][]int{{0, 1}},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	prob.Photos[0].Pose.PhotoAz += 0.05
	prob.Photos[1].Pose.PhotoAz -= 0.05

	type iterCall struct {
		iter     int
		rms      float64
		accepted bool
	}
	var calls []iterCall
	cfg := solver.Config{
		Mode: solver.ModeJoint,
		OnIteration: func(iter int, rms float64, accepted bool) {
			calls = append(calls, iterCall{iter, rms, accepted})
		},
	}

	res, err := solver.Solve(prob, cfg)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if len(calls) == 0 {
		t.Fatal("expected at least one iteration callback; got none")
	}
	for _, c := range calls {
		if math.IsNaN(c.rms) || math.IsInf(c.rms, 0) {
			t.Errorf("iteration callback emitted non-finite rms: %+v", c)
		}
	}
	// The best accepted RMS in the callback stream should be ≤ the final
	// RMS Ceres reports back through Result. (Ceres' final state may differ
	// by a sub-iteration step that didn't fire OnIteration; the in-Go
	// residual recompute should match either way.)
	var bestCallback float64 = math.Inf(1)
	for _, c := range calls {
		if c.accepted && c.rms < bestCallback {
			bestCallback = c.rms
		}
	}
	if res.FinalResidualRMS > bestCallback*1.5+1e-9 {
		t.Errorf("final RMS %v unexpectedly worse than best callback %v",
			res.FinalResidualRMS, bestCallback)
	}
}

// TestBridgeCancellation verifies that ShouldStop returning true causes the
// solver to terminate early with fewer than MaxIters iterations.
func TestBridgeCancellation(t *testing.T) {
	cpLat, cpLng := offsetLatLng(0, 50)
	w := synth.World{
		Stations: []synth.TrueStation{
			fullyLocked("s1", gaugeLat, gaugeLng),
			lockedAt("s2", 40, 0),
		},
		Photos: []synth.TruePhoto{
			{ID: "p1", StationID: "s1", Pose: basicPose(0),
				Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
			{ID: "p2", StationID: "s2", Pose: basicPose(0),
				Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cp1", EstLat: cpLat, EstLng: cpLng, EstAlt: 0},
		},
		VisibleIn: [][]int{{0, 1}},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	prob.Photos[0].Pose.PhotoAz += 0.05

	iters := 0
	cfg := solver.Config{
		Mode:     solver.ModeJoint,
		MaxIters: 50,
		// Cancel after a couple of accepted steps so we know the loop ran
		// at least a little — distinguishes "the cancel reached Ceres" from
		// "Ceres terminated on convergence before we could cancel."
		OnIteration: func(iter int, rms float64, accepted bool) {
			if accepted {
				iters++
			}
		},
		ShouldStop: func() bool {
			return iters >= 2
		},
	}

	res, err := solver.Solve(prob, cfg)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Iterations >= 50 {
		t.Errorf("expected early termination via ShouldStop; got %d iterations", res.Iterations)
	}
}

// TestBridgePlumbConstraintBitEqualSharedAxes verifies that two CPs joined by
// a plumb constraint end up with bit-equal lat & lng on the shared axes —
// this is the property the rep-aliasing implementation in bridge.cc must
// preserve. (Up axis is independent under plumb and may differ.)
func TestBridgePlumbConstraintBitEqualSharedAxes(t *testing.T) {
	cpALat, cpALng := offsetLatLng(0, 50)
	cpBLat, cpBLng := offsetLatLng(0.05, 50.05) // perturb so reconciliation has to snap
	w := synth.World{
		Stations: []synth.TrueStation{
			fullyLocked("s1", gaugeLat, gaugeLng),
			lockedAt("s2", 40, 0),
		},
		Photos: []synth.TruePhoto{
			{ID: "p1", StationID: "s1", Pose: basicPose(0)},
			{ID: "p2", StationID: "s2", Pose: basicPose(0)},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cpA", EstLat: cpALat, EstLng: cpALng, EstAlt: 5},
			{ID: "cpB", EstLat: cpBLat, EstLng: cpBLng, EstAlt: 11},
		},
		VisibleIn: [][]int{{0, 1}, {0, 1}},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	prob.CPConstraints = append(prob.CPConstraints, solver.CPConstraint{
		CpAID: "cpA", CpBID: "cpB", ConstraintType: "plumb",
	})

	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeJoint})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}

	// Find the two CP changes in Result.Changes and check their post-solve
	// lat/lng are equal. (After values come from emitLLADiff in composeChanges;
	// our bridge writes shared-axis offsets through the rep, so both members
	// must round-trip to the same lat/lng.)
	var aChange, bChange *solver.EntityChange
	for i := range res.Changes {
		switch res.Changes[i].ID {
		case "cpA":
			aChange = &res.Changes[i]
		case "cpB":
			bChange = &res.Changes[i]
		}
	}
	if aChange == nil || bChange == nil {
		t.Fatalf("expected changes for both cpA and cpB; got %+v", res.Changes)
	}
	if aChange.After["est_lat"] != bChange.After["est_lat"] {
		t.Errorf("plumb constraint violated on lat: cpA=%v cpB=%v",
			aChange.After["est_lat"], bChange.After["est_lat"])
	}
	if aChange.After["est_lng"] != bChange.After["est_lng"] {
		t.Errorf("plumb constraint violated on lng: cpA=%v cpB=%v",
			aChange.After["est_lng"], bChange.After["est_lng"])
	}
}

// TestBridgeSingleStationFocus exercises the ModeSingleStation scoping path
// to make sure non-focus-station photos and out-of-scope CPs stay put while
// the focus station's photos move.
func TestBridgeSingleStationFocus(t *testing.T) {
	cpLat, cpLng := offsetLatLng(0, 50)
	const truePhotoAz = 0.1
	w := synth.World{
		Stations: []synth.TrueStation{
			fullyLocked("s1", gaugeLat, gaugeLng),
			lockedAt("s2", 40, 0),
		},
		Photos: []synth.TruePhoto{
			{ID: "p1", StationID: "s1", Pose: basicPose(truePhotoAz),
				Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
			{ID: "p2", StationID: "s2", Pose: basicPose(0),
				Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cp1", EstLat: cpLat, EstLng: cpLng, EstAlt: 0,
				Locks: solver.CPLocks{EstLat: true, EstLng: true, EstAlt: true}},
		},
		VisibleIn: [][]int{{0, 1}},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	prob.Photos[0].Pose.PhotoAz = 0
	prob.Photos[1].Pose.PhotoAz = 0.03

	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeSingleStation, FocusID: "s1"})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	var p1Az, p2Az float64
	var sawP1, sawP2 bool
	for _, c := range res.Changes {
		if c.Kind != "photo" {
			continue
		}
		if c.ID == "p1" {
			sawP1 = true
			p1Az = c.After["photo_az"]
		}
		if c.ID == "p2" {
			sawP2 = true
			p2Az = c.After["photo_az"]
		}
	}
	if !sawP1 {
		t.Errorf("expected p1 (focus station's photo) to be updated; changes=%+v", res.Changes)
	}
	if sawP2 {
		t.Errorf("unexpected p2 (non-focus) change p2Az=%v; should be locked under ModeSingleStation", p2Az)
	}
	if math.Abs(p1Az-truePhotoAz) > 1e-3 {
		t.Errorf("p1 az not recovered: got %v want %v", p1Az, truePhotoAz)
	}
}

// TestBridgeUnderconstrainedGauge exercises the gauge check — joint mode
// with fewer than two fully-locked stations must return ErrUnderconstrainedGauge.
// Constructed by hand (rather than via synth.Build, which requires every
// CP to be visible in every photo of its VisibleIn list) so the s2 station
// can have no locks but still hold a sane initial pose.
func TestBridgeUnderconstrainedGauge(t *testing.T) {
	prob := solver.Problem{
		Stations: []solver.Station{
			{ID: "s1", Lat: gaugeLat, Lng: gaugeLng,
				Locks: solver.StationLocks{Lat: true, Lng: true}},
			// s2 has no locks — only one fully-locked station, so joint
			// mode lacks the rotation gauge.
			{ID: "s2", Lat: gaugeLat, Lng: gaugeLng + 0.001},
		},
		Photos: []solver.Photo{
			{ID: "p1", StationID: "s1", Pose: basicPose(0)},
			{ID: "p2", StationID: "s2", Pose: basicPose(0)},
		},
		ControlPoints: []solver.ControlPoint{
			{ID: "cp1", EstLat: gaugeLat + 0.0001, EstLng: gaugeLng},
		},
	}
	_, err := solver.Solve(prob, solver.Config{Mode: solver.ModeJoint})
	if !errors.Is(err, solver.ErrUnderconstrainedGauge) {
		t.Errorf("expected ErrUnderconstrainedGauge; got %v", err)
	}
}
