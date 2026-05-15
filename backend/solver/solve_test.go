package solver_test

import (
	"math"
	"testing"

	"github.com/bmander/panorama-builder/backend/solver"
	"github.com/bmander/panorama-builder/backend/solver/synth"
)

const (
	gaugeLat = 47.6097
	gaugeLng = -122.3331
)

// fullyLocked returns a station with both lat and lng locked.
func fullyLocked(id string, lat, lng float64) synth.TrueStation {
	return synth.TrueStation{
		ID:    id,
		Lat:   lat,
		Lng:   lng,
		Locks: solver.StationLocks{Lat: true, Lng: true},
	}
}

// lockedAt returns a fully-locked station at the given ENU offset from the
// gauge origin.
func lockedAt(id string, e, n float64) synth.TrueStation {
	lat, lng := offsetLatLng(e, n)
	return fullyLocked(id, lat, lng)
}

func basicPose(az float64) solver.Pose {
	return solver.Pose{
		PhotoAz:   az,
		PhotoTilt: 0,
		PhotoRoll: 0,
		SizeRad:   math.Pi / 2, // 90° FOV — wide enough for nearby CPs
		Aspect:    1.5,
	}
}

// offsetLatLng returns (lat, lng) at a given (east, north) offset in meters
// from the gauge origin.
func offsetLatLng(east, north float64) (float64, float64) {
	lat, lng, _ := solver.ENUToLatLngAlt(east, north, 0, gaugeLat, gaugeLng, 0)
	return lat, lng
}

func TestSolveIdentityNoChange(t *testing.T) {
	cpLat, cpLng := offsetLatLng(0, 50) // 50m due north
	w := synth.World{
		Stations: []synth.TrueStation{
			fullyLocked("st1", gaugeLat, gaugeLng),
			lockedAt("st2", 20, 0),
		},
		Photos: []synth.TruePhoto{
			{ID: "p1", StationID: "st1", Pose: basicPose(0)},
			{ID: "p2", StationID: "st2", Pose: basicPose(0)},
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
	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeJoint})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.InitialResidualRMS > 1e-10 {
		t.Errorf("identity world should have ~zero initial residual; got %v", res.InitialResidualRMS)
	}
	if len(res.Changes) != 0 {
		t.Errorf("identity world should have no changes; got %d", len(res.Changes))
	}
}

func TestSolveSingleStationRecoversPhotoAz(t *testing.T) {
	cpLat, cpLng := offsetLatLng(0, 50)
	const truePhotoAz = 0.1
	w := synth.World{
		Stations: []synth.TrueStation{
			fullyLocked("st1", gaugeLat, gaugeLng),
		},
		Photos: []synth.TruePhoto{
			// Only photo_az unlocked: with 1 observation the system has 2 residual
			// rows and 1 unknown — well-conditioned. (Unlocking tilt/roll/size with
			// a single observation makes the Jacobian rank-deficient; a real user
			// avoids that via locks, mirrored here.)
			{ID: "p1", StationID: "st1", Pose: basicPose(truePhotoAz),
				Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cp1", EstLat: cpLat, EstLng: cpLng, EstAlt: 0,
				Locks: solver.CPLocks{EstLat: true, EstLng: true, EstAlt: true}},
		},
		VisibleIn: [][]int{{0}},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	// Perturb photo_az by 5° before handing to the solver.
	prob.Photos[0].Pose.PhotoAz = truePhotoAz + 5*math.Pi/180

	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeSingleStation, FocusID: "st1"})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("should not diverge: %+v", res)
	}
	// One change expected: photo p1, photo_az.
	if len(res.Changes) != 1 || res.Changes[0].Kind != "photo" || res.Changes[0].ID != "p1" {
		t.Fatalf("expected single photo change for p1; got %+v", res.Changes)
	}
	got := res.Changes[0].After["photo_az"]
	if math.Abs(solver.WrapPi(got-truePhotoAz)) > 1e-4 {
		t.Errorf("photo_az not recovered: got %v want %v (Δ=%v)", got, truePhotoAz, got-truePhotoAz)
	}
}

func TestSolveSingleStationJointPoseRecovery(t *testing.T) {
	// 1 station, 3 photos at different azimuths, 3 CPs at different bearings.
	cps := []struct{ lat, lng float64 }{
		mustOffset(0, 60),
		mustOffset(40, 40),
		mustOffset(-30, 50),
	}
	const trueAz1, trueAz2, trueAz3 = 0.0, -math.Pi / 4, math.Pi / 6
	w := synth.World{
		Stations: []synth.TrueStation{fullyLocked("st1", gaugeLat, gaugeLng)},
		Photos: []synth.TruePhoto{
			// Lock tilt/roll: with only 1 observation per photo, only photo_az
			// and size_rad are well-determined. Lock those that aren't.
			{ID: "p1", StationID: "st1", Pose: basicPose(trueAz1),
				Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
			{ID: "p2", StationID: "st1", Pose: basicPose(trueAz2),
				Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
			{ID: "p3", StationID: "st1", Pose: basicPose(trueAz3),
				Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cpA", EstLat: cps[0].lat, EstLng: cps[0].lng,
				Locks: solver.CPLocks{EstLat: true, EstLng: true, EstAlt: true}},
			{ID: "cpB", EstLat: cps[1].lat, EstLng: cps[1].lng,
				Locks: solver.CPLocks{EstLat: true, EstLng: true, EstAlt: true}},
			{ID: "cpC", EstLat: cps[2].lat, EstLng: cps[2].lng,
				Locks: solver.CPLocks{EstLat: true, EstLng: true, EstAlt: true}},
		},
		VisibleIn: [][]int{
			{0}, // cpA → p1
			{1}, // cpB → p2
			{2}, // cpC → p3
		},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	for i := range prob.Photos {
		prob.Photos[i].Pose.PhotoAz += 0.05
	}
	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeSingleStation, FocusID: "st1"})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("should not diverge: %+v", res)
	}
	want := map[string]float64{"p1": trueAz1, "p2": trueAz2, "p3": trueAz3}
	for _, c := range res.Changes {
		if c.Kind != "photo" {
			continue
		}
		az, ok := c.After["photo_az"]
		if !ok {
			continue
		}
		exp, found := want[c.ID]
		if !found {
			t.Errorf("unexpected photo id in changes: %s", c.ID)
			continue
		}
		if math.Abs(solver.WrapPi(az-exp)) > 1e-3 {
			t.Errorf("photo %s az: got %v want ~%v", c.ID, az, exp)
		}
	}
}

func mustOffset(e, n float64) struct{ lat, lng float64 } {
	lat, lng := offsetLatLng(e, n)
	return struct{ lat, lng float64 }{lat, lng}
}

func TestSolveLockHonored(t *testing.T) {
	cpLat, cpLng := offsetLatLng(0, 50)
	w := synth.World{
		Stations: []synth.TrueStation{fullyLocked("st1", gaugeLat, gaugeLng)},
		Photos: []synth.TruePhoto{
			{ID: "p1", StationID: "st1", Pose: basicPose(0),
				Locks: solver.PhotoLocks{PhotoAz: true, PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cp1", EstLat: cpLat, EstLng: cpLng,
				Locks: solver.CPLocks{EstLat: true, EstLng: true, EstAlt: true}},
		},
		VisibleIn: [][]int{{0}},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	prob.Photos[0].Pose.PhotoAz = 0.05 // perturb the locked param
	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeSingleStation, FocusID: "st1"})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	for _, c := range res.Changes {
		if c.Kind == "photo" {
			if _, present := c.After["photo_az"]; present {
				t.Errorf("photo_az was supposed to be locked but solver wrote %v", c.After["photo_az"])
			}
		}
	}
}

func TestSolveControlPointRecovery(t *testing.T) {
	// 3 stations, each with 1 photo, all pointing at CP. CP at (0, 50, 5).
	// Perturb CP est_lat / est_lng / est_alt; solve should recover.
	cpTrueLat, cpTrueLng := offsetLatLng(0, 50)
	const cpTrueAlt = 5.0
	w := synth.World{
		Stations: []synth.TrueStation{
			fullyLocked("s1", gaugeLat, gaugeLng),
			lockedAt("s2", 40, 0),
			lockedAt("s3", -40, 0),
		},
		Photos: []synth.TruePhoto{
			{ID: "ph1", StationID: "s1", Pose: basicPose(0),
				Locks: solver.PhotoLocks{PhotoAz: true, PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
			{ID: "ph2", StationID: "s2", Pose: basicPose(0),
				Locks: solver.PhotoLocks{PhotoAz: true, PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
			{ID: "ph3", StationID: "s3", Pose: basicPose(0),
				Locks: solver.PhotoLocks{PhotoAz: true, PhotoTilt: true, PhotoRoll: true, SizeRad: true}},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cp1", EstLat: cpTrueLat, EstLng: cpTrueLng, EstAlt: cpTrueAlt},
		},
		VisibleIn: [][]int{{0, 1, 2}},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	// Perturb CP est_*.
	prob.ControlPoints[0].EstLat = cpTrueLat + 5e-5 // ~5m
	prob.ControlPoints[0].EstLng = cpTrueLng + 5e-5
	prob.ControlPoints[0].EstAlt = cpTrueAlt + 3
	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeSingleControlPoint, FocusID: "cp1"})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("should not diverge: %+v", res)
	}
	if len(res.Changes) != 1 || res.Changes[0].Kind != "control_point" {
		t.Fatalf("expected one CP change; got %+v", res.Changes)
	}
	got := res.Changes[0].After
	if math.Abs(got["est_lat"]-cpTrueLat) > 1e-7 {
		t.Errorf("est_lat: got %v want %v", got["est_lat"], cpTrueLat)
	}
	if math.Abs(got["est_lng"]-cpTrueLng) > 1e-7 {
		t.Errorf("est_lng: got %v want %v", got["est_lng"], cpTrueLng)
	}
	if math.Abs(got["est_alt"]-cpTrueAlt) > 0.1 {
		t.Errorf("est_alt: got %v want %v", got["est_alt"], cpTrueAlt)
	}
}

func TestSolveJointGaugeRequired(t *testing.T) {
	cpLat, cpLng := offsetLatLng(0, 50)
	w := synth.World{
		Stations: []synth.TrueStation{
			// Only one station fully locked → gauge underconstrained for joint mode.
			fullyLocked("s1", gaugeLat, gaugeLng),
			{ID: "s2", Lat: gaugeLat, Lng: gaugeLng + 0.0005}, // unlocked
		},
		Photos: []synth.TruePhoto{
			{ID: "p1", StationID: "s1", Pose: basicPose(0)},
			{ID: "p2", StationID: "s2", Pose: basicPose(0)},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cp1", EstLat: cpLat, EstLng: cpLng,
				Locks: solver.CPLocks{EstLat: true, EstLng: true, EstAlt: true}},
		},
		VisibleIn: [][]int{{0, 1}},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	_, err = solver.Solve(prob, solver.Config{Mode: solver.ModeJoint})
	if err != solver.ErrUnderconstrainedGauge {
		t.Errorf("want ErrUnderconstrainedGauge; got %v", err)
	}
}

func TestSolveJointBundleAdjustment(t *testing.T) {
	// 4 stations at corners of a 100m square; 5 CPs clustered ~250m north so
	// every photo (photo_az = 0, FOV = 120°) sees them all. Stations 0 and 1
	// are fully locked (gauge); station 2 and 3 have lat/lng free. Photo
	// orientations are also free (photo_az), with tilt/roll/size locked
	// because each photo's per-CP observations don't constrain them on this
	// scale of test data.
	stPositions := [][2]float64{
		{0, 0}, {100, 0}, {100, 100}, {0, 100},
	}
	cpPositions := [][3]float64{
		{50, 250, 5}, {40, 240, 0}, {60, 260, -2}, {50, 280, 8}, {30, 270, 3},
	}
	stations := make([]synth.TrueStation, len(stPositions))
	for i, p := range stPositions {
		lat, lng := offsetLatLng(p[0], p[1])
		st := synth.TrueStation{ID: stID(i), Lat: lat, Lng: lng}
		if i < 2 {
			st.Locks = solver.StationLocks{Lat: true, Lng: true}
		}
		stations[i] = st
	}
	photos := make([]synth.TruePhoto, len(stPositions))
	for i := range stPositions {
		photos[i] = synth.TruePhoto{
			ID: photoID(i), StationID: stID(i),
			Pose:  solver.Pose{PhotoAz: 0, PhotoTilt: 0, PhotoRoll: 0, SizeRad: 2 * math.Pi / 3, Aspect: 1.5},
			Locks: solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true},
		}
	}
	cps := make([]synth.TrueCP, len(cpPositions))
	visibility := make([][]int, len(cpPositions))
	for i, p := range cpPositions {
		lat, lng, alt := solver.ENUToLatLngAlt(p[0], p[1], p[2], gaugeLat, gaugeLng, 0)
		cps[i] = synth.TrueCP{ID: cpID(i), EstLat: lat, EstLng: lng, EstAlt: alt}
		// All four photos see every CP.
		visibility[i] = []int{0, 1, 2, 3}
	}

	w := synth.World{Stations: stations, Photos: photos, ControlPoints: cps, VisibleIn: visibility}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}

	// Perturb unlocked stations (~3m drift), all photo_az, all CP positions.
	for i := range prob.Stations {
		if prob.Stations[i].Locks.Lat {
			continue
		}
		dLat, _ := offsetLatLng(0, 3)
		_, dLng := offsetLatLng(2, 0)
		prob.Stations[i].Lat += dLat - gaugeLat
		prob.Stations[i].Lng += dLng - gaugeLng
	}
	for i := range prob.Photos {
		prob.Photos[i].Pose.PhotoAz += 0.02
	}
	for i := range prob.ControlPoints {
		prob.ControlPoints[i].EstLat += 5e-6
		prob.ControlPoints[i].EstLng += 5e-6
		prob.ControlPoints[i].EstAlt += 0.5
	}

	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeJoint, MaxIters: 80})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("bundle adjust diverged: %+v", res)
	}
	if res.FinalResidualRMS > 1e-3 {
		t.Errorf("residual too high after bundle adjust: %v rad RMS", res.FinalResidualRMS)
	}
	t.Logf("bundle adjust: iters=%d initial=%v final=%v", res.Iterations, res.InitialResidualRMS, res.FinalResidualRMS)
}

func stID(i int) string    { return string(rune('a'+i)) + "stat" }
func photoID(i int) string { return string(rune('a'+i)) + "phot" }
func cpID(i int) string    { return string(rune('a'+i)) + "cppp" }

func TestSolveRankDeficientColumnAutoLocks(t *testing.T) {
	// Two stations (gauge ok), two CPs: cp1 observed from both, cp2 observed
	// from none. cp2's est_lat/lng/alt slots have zero Jacobian columns and
	// must be auto-locked, with no NaN propagation.
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
			{ID: "cp1", EstLat: cpLat, EstLng: cpLng},
			{ID: "cp2", EstLat: gaugeLat + 0.001, EstLng: gaugeLng + 0.001},
		},
		VisibleIn: [][]int{{0, 1}, nil},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	// Perturb cp1 to force iterations (so the Jacobian gets evaluated and
	// cp2's all-zero columns get detected).
	prob.ControlPoints[0].EstLat += 1e-5
	prob.ControlPoints[0].EstLng += 1e-5
	prob.Photos[0].Pose.PhotoAz += 0.01
	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeJoint})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	// The load-bearing assertion: a rank-deficient unobserved CP must not
	// produce NaN in the residual. Ceres' LM damping handles this silently.
	if math.IsNaN(res.FinalResidualRMS) {
		t.Fatalf("residual is NaN; rank-defect not handled")
	}
}

func TestSolveRecoversK1K2(t *testing.T) {
	// One station + one wide-FOV photo + 5 CPs spread across the image plane
	// at different radii from the optical axis. The photo's true pose has
	// non-zero K1, K2 (Brown-Conrady radial distortion). Pose, station, and
	// CPs are all locked so the only free parameters are K1 and K2; the
	// solver must recover them from the radial residual pattern.
	const trueK1, trueK2 = -0.12, 0.04
	// CP positions in (east, north, up) meters from the gauge. Mix of radii
	// from photo center (PhotoAz = 0, looking due north) so r² varies enough
	// to constrain K1 and K2 separately.
	cpPositions := [][3]float64{
		{0, 250, 0},     // near image center
		{120, 250, 0},   // off-axis right
		{-120, 250, 30}, // off-axis left + up
		{60, 250, -40},  // mid-radius below
		{-90, 260, 50},  // far corner
	}
	cps := make([]synth.TrueCP, len(cpPositions))
	visibility := make([][]int, len(cpPositions))
	for i, p := range cpPositions {
		lat, lng, alt := solver.ENUToLatLngAlt(p[0], p[1], p[2], gaugeLat, gaugeLng, 0)
		cps[i] = synth.TrueCP{
			ID: cpID(i), EstLat: lat, EstLng: lng, EstAlt: alt,
			Locks: solver.CPLocks{EstLat: true, EstLng: true, EstAlt: true},
		}
		visibility[i] = []int{0}
	}
	w := synth.World{
		Stations: []synth.TrueStation{fullyLocked("st1", gaugeLat, gaugeLng)},
		Photos: []synth.TruePhoto{
			{
				ID: "p1", StationID: "st1",
				Pose: solver.Pose{
					PhotoAz: 0, PhotoTilt: 0, PhotoRoll: 0,
					SizeRad: 2 * math.Pi / 3, Aspect: 1.5,
					K1: trueK1, K2: trueK2,
				},
				Locks: solver.PhotoLocks{
					PhotoAz: true, PhotoTilt: true, PhotoRoll: true, SizeRad: true,
				},
			},
		},
		ControlPoints: cps,
		VisibleIn:     visibility,
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	// Perturb K1, K2 well away from the truth so the solver has work to do.
	prob.Photos[0].Pose.K1 = 0
	prob.Photos[0].Pose.K2 = 0

	// Disable Tikhonov regularization on k1/k2 — this test validates the
	// ideal-data recovery, where any nonzero λ would bias the recovered
	// values toward zero by the expected JᵀJ/(JᵀJ+λ²) shrinkage factor.
	res, err := solver.Solve(prob, solver.Config{
		Mode: solver.ModeSingleStation, FocusID: "st1",
		KRegLambda: -1,
	})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("should not diverge: %+v", res)
	}
	if len(res.Changes) != 1 || res.Changes[0].Kind != "photo" || res.Changes[0].ID != "p1" {
		t.Fatalf("expected one photo change for p1; got %+v", res.Changes)
	}
	got := res.Changes[0].After
	if math.Abs(got["dist_k1"]-trueK1) > 1e-3 {
		t.Errorf("dist_k1: got %v want %v", got["dist_k1"], trueK1)
	}
	if math.Abs(got["dist_k2"]-trueK2) > 1e-3 {
		t.Errorf("dist_k2: got %v want %v", got["dist_k2"], trueK2)
	}
}

// threeStationCPPair builds a 3-station / 2-CP joint world with the given
// true CP positions. Stations are at (0,0), (15,0), (-15,0) with all of
// lat/lng/alt locked (no vertical gauge ambiguity), looking due north with
// 90° FOV; photos have every rotation/size lock set so the only free
// parameters are the CP positions themselves. Used by the CP-constraint
// tests so we can assert exact equality of shared params without poses or
// gauge ambiguities bleeding noise into the residual.
func threeStationCPPair(t *testing.T, cpAENU, cpBENU [3]float64) solver.Problem {
	t.Helper()
	cpALat, cpALng, cpAAlt := solver.ENUToLatLngAlt(cpAENU[0], cpAENU[1], cpAENU[2], gaugeLat, gaugeLng, 0)
	cpBLat, cpBLng, cpBAlt := solver.ENUToLatLngAlt(cpBENU[0], cpBENU[1], cpBENU[2], gaugeLat, gaugeLng, 0)
	allPhotoLocks := solver.PhotoLocks{PhotoAz: true, PhotoTilt: true, PhotoRoll: true, SizeRad: true}
	allStationLocks := solver.StationLocks{Lat: true, Lng: true, Alt: true}
	mkStation := func(id string, e, n float64) synth.TrueStation {
		lat, lng := offsetLatLng(e, n)
		return synth.TrueStation{ID: id, Lat: lat, Lng: lng, Locks: allStationLocks}
	}
	w := synth.World{
		Stations: []synth.TrueStation{
			mkStation("s1", 0, 0),
			mkStation("s2", 15, 0),
			mkStation("s3", -15, 0),
		},
		Photos: []synth.TruePhoto{
			{ID: "p1", StationID: "s1", Pose: basicPose(0), Locks: allPhotoLocks},
			{ID: "p2", StationID: "s2", Pose: basicPose(0), Locks: allPhotoLocks},
			{ID: "p3", StationID: "s3", Pose: basicPose(0), Locks: allPhotoLocks},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cpA", EstLat: cpALat, EstLng: cpALng, EstAlt: cpAAlt},
			{ID: "cpB", EstLat: cpBLat, EstLng: cpBLng, EstAlt: cpBAlt},
		},
		// All three photos see both CPs — 12 observations total.
		VisibleIn: [][]int{{0, 1, 2}, {0, 1, 2}},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}
	return prob
}

func cpByID(prob solver.Problem, id string) *solver.ControlPoint {
	for i := range prob.ControlPoints {
		if prob.ControlPoints[i].ID == id {
			return &prob.ControlPoints[i]
		}
	}
	return nil
}

func cpChangeAfter(res solver.Result, id string) map[string]float64 {
	for _, c := range res.Changes {
		if c.Kind == "control_point" && c.ID == id {
			return c.After
		}
	}
	return nil
}

// TestSolveCPConstraintPlumbSharesLatLng verifies a "plumb" constraint forces
// est_lat and est_lng to be identical on both CPs after a joint solve, even
// when the inputs disagree. cpA and cpB share true lat/lng but differ in
// altitude — perturbing cpA's lat/lng pulls cpB along during reconciliation,
// and the joint solve then drives the shared parameters back to truth.
func TestSolveCPConstraintPlumbSharesLatLng(t *testing.T) {
	prob := threeStationCPPair(t, [3]float64{0, 30, 5}, [3]float64{0, 30, 12})
	prob.CPConstraints = []solver.CPConstraint{
		{CpAID: "cpA", CpBID: "cpB", ConstraintType: "plumb"},
	}
	// Perturb both CPs (different magnitudes) so reconciliation forces a snap
	// on cpB AND the solver still has work to do on the shared lat/lng slots.
	prob.ControlPoints[0].EstLat += 5e-5 // ~5m
	prob.ControlPoints[0].EstLng += 5e-5
	prob.ControlPoints[1].EstLat += 1e-4 // ~10m
	prob.ControlPoints[1].EstLng += 1e-4

	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeJoint, MaxIters: 80})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("plumb solve diverged: %+v", res)
	}
	afterA := cpChangeAfter(res, "cpA")
	afterB := cpChangeAfter(res, "cpB")
	if afterA == nil || afterB == nil {
		t.Fatalf("expected changes for both cpA and cpB; got %+v", res.Changes)
	}
	if afterA["est_lat"] != afterB["est_lat"] {
		t.Errorf("plumb: est_lat must match exactly; cpA=%v cpB=%v", afterA["est_lat"], afterB["est_lat"])
	}
	if afterA["est_lng"] != afterB["est_lng"] {
		t.Errorf("plumb: est_lng must match exactly; cpA=%v cpB=%v", afterA["est_lng"], afterB["est_lng"])
	}
	// Sanity: shared lat is near truth (truth = unperturbed lat of cpA = cpB).
	cpTrueLat, _ := offsetLatLng(0, 30)
	if math.Abs(afterA["est_lat"]-cpTrueLat) > 1e-7 {
		t.Errorf("shared est_lat should converge near truth; got %v want %v", afterA["est_lat"], cpTrueLat)
	}
}

// TestSolveCPConstraintLevelSharesAlt verifies "level" forces est_alt to be
// identical and leaves lat/lng free per CP. cpA and cpB share true alt but
// differ in lat; perturbing cpA's alt drags cpB through reconciliation, and
// the joint solve recovers the shared alt from both CPs' observations.
func TestSolveCPConstraintLevelSharesAlt(t *testing.T) {
	prob := threeStationCPPair(t, [3]float64{4, 30, 7}, [3]float64{-4, 30, 7})
	prob.CPConstraints = []solver.CPConstraint{
		{CpAID: "cpA", CpBID: "cpB", ConstraintType: "level"},
	}
	// Perturb both CPs' alt by different amounts so reconciliation snaps cpB
	// onto cpA and the shared-alt slot still has work to do on the joint
	// minimum.
	prob.ControlPoints[0].EstAlt += 4
	prob.ControlPoints[1].EstAlt -= 2

	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeJoint, MaxIters: 80})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("level solve diverged: %+v", res)
	}
	afterA := cpChangeAfter(res, "cpA")
	afterB := cpChangeAfter(res, "cpB")
	if afterA == nil || afterB == nil {
		t.Fatalf("expected changes for both cpA and cpB; got %+v", res.Changes)
	}
	if afterA["est_alt"] != afterB["est_alt"] {
		t.Errorf("level: est_alt must match exactly; cpA=%v cpB=%v", afterA["est_alt"], afterB["est_alt"])
	}
	// Sanity: shared alt is near truth (7). Vertical observability with three
	// stations and a 13° elevation angle is decent but not exact; allow 0.5m.
	if math.Abs(afterA["est_alt"]-7) > 0.5 {
		t.Errorf("shared est_alt should converge near truth (7); got %v", afterA["est_alt"])
	}
}

// TestSolveCPConstraintLockPropagates verifies a lock on one class member
// suppresses the slot for every member on the locked axis: the locked value
// dominates reconciliation, and the change record still surfaces the snap on
// the non-locked partner so writeback persists it.
func TestSolveCPConstraintLockPropagates(t *testing.T) {
	prob := threeStationCPPair(t, [3]float64{4, 30, 7}, [3]float64{-4, 30, 7})
	prob.CPConstraints = []solver.CPConstraint{
		{CpAID: "cpA", CpBID: "cpB", ConstraintType: "level"},
	}
	// Lock cpA's est_alt at a value (60) that differs from cpB's seeded
	// est_alt (7). Reconciliation must snap cpB to 60.
	cpA := cpByID(prob, "cpA")
	cpA.EstAlt = 60
	cpA.Locks.EstAlt = true
	// Lock everything else free of free-parameter noise so the solve trivially
	// settles and we can assert on the change record.
	for i := range prob.ControlPoints {
		prob.ControlPoints[i].Locks.EstLat = true
		prob.ControlPoints[i].Locks.EstLng = true
	}

	res, err := solver.Solve(prob, solver.Config{Mode: solver.ModeJoint})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("locked-class solve diverged: %+v", res)
	}
	afterB := cpChangeAfter(res, "cpB")
	if afterB == nil {
		t.Fatalf("expected a reconciliation change for cpB; got %+v", res.Changes)
	}
	if math.Abs(afterB["est_alt"]-60) > 1e-9 {
		t.Errorf("cpB est_alt should snap to cpA's locked value (60); got %v", afterB["est_alt"])
	}
	// cpA didn't move (it was already at 60 with the lock); no est_alt change.
	if afterA := cpChangeAfter(res, "cpA"); afterA != nil {
		if _, present := afterA["est_alt"]; present {
			t.Errorf("cpA was locked at 60; should not appear in changes for est_alt: %+v", afterA)
		}
	}
}
