//go:build !noceres

package solver_test

import (
	"math"
	"testing"

	"github.com/bmander/panorama-builder/backend/solver"
	"github.com/bmander/panorama-builder/backend/solver/synth"
)

// fourStationWorld returns a 4-station / 4-photo world with the given CPs and
// per-CP visibility lists. Stations 0/1 are fully locked (gauge), 2/3 free.
// All photos point north with a 120° FOV — wide enough to keep CPs in-frame
// when perturbed in the test.
func fourStationWorld(cps []synth.TrueCP, visibility [][]int) synth.World {
	stPositions := [][2]float64{{0, 0}, {100, 0}, {100, 100}, {0, 100}}
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
			Pose: solver.Pose{
				PhotoAz: 0, PhotoTilt: 0, PhotoRoll: 0,
				SizeRad: 2 * math.Pi / 3, Aspect: 1.5,
			},
			// Lock all photo intrinsics so this fixture isolates CP geometry.
			Locks: solver.PhotoLocks{
				PhotoAz: true, PhotoTilt: true, PhotoRoll: true, SizeRad: true,
			},
		}
	}
	return synth.World{Stations: stations, Photos: photos, ControlPoints: cps, VisibleIn: visibility}
}

// stationCentroid returns the lat/lng centroid of the given stations.
func stationCentroid(stations []solver.Station) (lat, lng float64) {
	for _, s := range stations {
		lat += s.Lat
		lng += s.Lng
	}
	n := float64(len(stations))
	return lat / n, lng / n
}

// findCPChange returns the EntityChange for the given CP id, or nil.
func findCPChange(changes []solver.EntityChange, id string) *solver.EntityChange {
	for i := range changes {
		c := &changes[i]
		if c.Kind == "control_point" && c.ID == id {
			return c
		}
	}
	return nil
}

func TestSolveJointWithSeedRecoversNullCP(t *testing.T) {
	// Single CP at (50, 250, 5) ENU; all 4 photos see it. The DB-side seeder
	// would replace NULL est_lat/est_lng with the station-centroid; we
	// simulate that by overwriting EstLat/EstLng after Build, then ask
	// SolveJointWithSeed to run a per-CP refinement before joint. The free
	// stations (idx 2, 3) get a small position perturbation so the joint
	// phase has measurable work and the test exercises the full pipeline.
	cpTrueLat, cpTrueLng, cpTrueAlt := solver.ENUToLatLngAlt(75, 250, 5, gaugeLat, gaugeLng, 0)
	w := fourStationWorld(
		[]synth.TrueCP{{ID: "cp1", EstLat: cpTrueLat, EstLng: cpTrueLng, EstAlt: cpTrueAlt}},
		[][]int{{0, 1, 2, 3}},
	)
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}

	centroidLat, centroidLng := stationCentroid(prob.Stations)
	prob.ControlPoints[0].EstLat = centroidLat
	prob.ControlPoints[0].EstLng = centroidLng
	prob.ControlPoints[0].EstAlt = 0

	// Nudge unlocked stations so joint has > 0 residual to start from.
	dLat, _ := offsetLatLng(0, 0.5)
	for i := range prob.Stations {
		if prob.Stations[i].Locks.Lat {
			continue
		}
		prob.Stations[i].Lat += dLat - gaugeLat
	}

	res, err := solver.SolveJointWithSeed(prob, []string{"cp1"}, solver.Config{MaxIters: 80})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("should not diverge: %+v", res)
	}

	c := findCPChange(res.Changes, "cp1")
	if c == nil {
		t.Fatalf("expected control_point change for cp1; got %+v", res.Changes)
	}
	if got := c.Before["est_lat"]; math.Abs(got-centroidLat) > 1e-12 {
		t.Errorf("Before.est_lat: got %v want %v (centroid)", got, centroidLat)
	}
	if got := c.Before["est_lng"]; math.Abs(got-centroidLng) > 1e-12 {
		t.Errorf("Before.est_lng: got %v want %v (centroid)", got, centroidLng)
	}
	// 5e-6 deg ≈ 0.5m — generous slack for a 4-station triangulation that
	// starts from a 200m centroid seed. The point is "recovered", not
	// "to-the-millimeter".
	if got := c.After["est_lat"]; math.Abs(got-cpTrueLat) > 5e-6 {
		t.Errorf("After.est_lat: got %v want %v (truth)", got, cpTrueLat)
	}
	if got := c.After["est_lng"]; math.Abs(got-cpTrueLng) > 5e-6 {
		t.Errorf("After.est_lng: got %v want %v (truth)", got, cpTrueLng)
	}
	if got := c.After["est_alt"]; math.Abs(got-cpTrueAlt) > 0.5 {
		t.Errorf("After.est_alt: got %v want %v (truth)", got, cpTrueAlt)
	}
}

func TestSolveJointWithSeedDoesNotPerturbWellLocatedNeighbors(t *testing.T) {
	// Three CPs: cp1 starts at the station centroid (simulating the null-seed
	// case), cp2 and cp3 start at their truth. With pre-solve handling cp1
	// in isolation, the joint phase sees the CPs already near-truth and
	// should leave cp2 essentially untouched. (Without pre-solve, the early
	// joint iterations would tug cp2 around while chasing cp1.)
	//
	// A third well-located CP is needed because the per-station auto-lock
	// policy requires ≥3 matched obs per station to leave lat/lng free; with
	// only 2 CPs each station would auto-lock at its perturbed position and
	// the test's nudge-and-recover dynamic would be neutralized.
	cp1Lat, cp1Lng, cp1Alt := solver.ENUToLatLngAlt(75, 250, 5, gaugeLat, gaugeLng, 0)
	cp2Lat, cp2Lng, cp2Alt := solver.ENUToLatLngAlt(40, 240, 0, gaugeLat, gaugeLng, 0)
	cp3Lat, cp3Lng, cp3Alt := solver.ENUToLatLngAlt(-30, 260, 0, gaugeLat, gaugeLng, 0)
	w := fourStationWorld(
		[]synth.TrueCP{
			{ID: "cp1", EstLat: cp1Lat, EstLng: cp1Lng, EstAlt: cp1Alt},
			{ID: "cp2", EstLat: cp2Lat, EstLng: cp2Lng, EstAlt: cp2Alt},
			{ID: "cp3", EstLat: cp3Lat, EstLng: cp3Lng, EstAlt: cp3Alt},
		},
		[][]int{{0, 1, 2, 3}, {0, 1, 2, 3}, {0, 1, 2, 3}},
	)
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}

	centroidLat, centroidLng := stationCentroid(prob.Stations)
	prob.ControlPoints[0].EstLat = centroidLat
	prob.ControlPoints[0].EstLng = centroidLng
	prob.ControlPoints[0].EstAlt = 0

	// Nudge unlocked stations so joint has > 0 residual to start from.
	dLat, _ := offsetLatLng(0, 0.5)
	for i := range prob.Stations {
		if prob.Stations[i].Locks.Lat {
			continue
		}
		prob.Stations[i].Lat += dLat - gaugeLat
	}

	res, err := solver.SolveJointWithSeed(prob, []string{"cp1"}, solver.Config{MaxIters: 80})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("should not diverge: %+v", res)
	}

	// cp2 was already at truth; assert it didn't drift more than 1cm in any
	// axis. (FD scale is 1mm; 1cm is generous slack for the joint phase
	// noise floor on a 4-station / 2-CP problem.)
	if c := findCPChange(res.Changes, "cp2"); c != nil {
		if v, ok := c.After["est_lat"]; ok && math.Abs((v-cp2Lat)*solver.MPerDegLat) > 0.01 {
			t.Errorf("cp2 est_lat drifted: After=%v truth=%v", v, cp2Lat)
		}
		if v, ok := c.After["est_lng"]; ok {
			cosLat := math.Cos(gaugeLat * math.Pi / 180)
			if math.Abs((v-cp2Lng)*solver.MPerDegLat*cosLat) > 0.01 {
				t.Errorf("cp2 est_lng drifted: After=%v truth=%v", v, cp2Lng)
			}
		}
		if v, ok := c.After["est_alt"]; ok && math.Abs(v-cp2Alt) > 0.05 {
			t.Errorf("cp2 est_alt drifted: After=%v truth=%v", v, cp2Alt)
		}
	}
}

func TestSolveJointWithSeedEmptySeedListEqualsPlainSolve(t *testing.T) {
	// With no seeded CPs SolveJointWithSeed should be a transparent wrapper
	// over Solve(Mode=ModeJoint). Build the same scenario as
	// TestSolveJointBundleAdjustment, perturb identically, and compare
	// final residuals.
	cpPositions := [][3]float64{
		{50, 250, 5}, {40, 240, 0}, {60, 260, -2}, {50, 280, 8}, {30, 270, 3},
	}
	cps := make([]synth.TrueCP, len(cpPositions))
	visibility := make([][]int, len(cpPositions))
	for i, p := range cpPositions {
		lat, lng, alt := solver.ENUToLatLngAlt(p[0], p[1], p[2], gaugeLat, gaugeLng, 0)
		cps[i] = synth.TrueCP{ID: cpID(i), EstLat: lat, EstLng: lng, EstAlt: alt}
		visibility[i] = []int{0, 1, 2, 3}
	}
	w := fourStationWorld(cps, visibility)
	// Photo intrinsics need photo_az free for this regression to mirror the
	// existing bundle-adjustment fixture; rebuild photos with photo_az free.
	for i := range w.Photos {
		w.Photos[i].Locks = solver.PhotoLocks{PhotoTilt: true, PhotoRoll: true, SizeRad: true}
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}

	perturb := func(p *solver.Problem) {
		for i := range p.Stations {
			if p.Stations[i].Locks.Lat {
				continue
			}
			dLat, _ := offsetLatLng(0, 3)
			_, dLng := offsetLatLng(2, 0)
			p.Stations[i].Lat += dLat - gaugeLat
			p.Stations[i].Lng += dLng - gaugeLng
		}
		for i := range p.Photos {
			p.Photos[i].Pose.PhotoAz += 0.02
		}
		for i := range p.ControlPoints {
			p.ControlPoints[i].EstLat += 5e-6
			p.ControlPoints[i].EstLng += 5e-6
			p.ControlPoints[i].EstAlt += 0.5
		}
	}

	// Two independent copies so the two solves don't share state.
	probA := prob
	probA.Stations = append([]solver.Station(nil), prob.Stations...)
	probA.Photos = append([]solver.Photo(nil), prob.Photos...)
	probA.ControlPoints = append([]solver.ControlPoint(nil), prob.ControlPoints...)
	probA.Observations = append([]solver.Observation(nil), prob.Observations...)
	perturb(&probA)

	probB := prob
	probB.Stations = append([]solver.Station(nil), prob.Stations...)
	probB.Photos = append([]solver.Photo(nil), prob.Photos...)
	probB.ControlPoints = append([]solver.ControlPoint(nil), prob.ControlPoints...)
	probB.Observations = append([]solver.Observation(nil), prob.Observations...)
	perturb(&probB)

	resPlain, err := solver.Solve(probA, solver.Config{Mode: solver.ModeJoint, MaxIters: 80})
	if err != nil {
		t.Fatalf("plain solve: %v", err)
	}
	resWrapped, err := solver.SolveJointWithSeed(probB, nil, solver.Config{MaxIters: 80})
	if err != nil {
		t.Fatalf("wrapped solve: %v", err)
	}
	if resPlain.Iterations != resWrapped.Iterations {
		t.Errorf("iter count: plain=%d wrapped=%d", resPlain.Iterations, resWrapped.Iterations)
	}
	if math.Abs(resPlain.FinalResidualRMS-resWrapped.FinalResidualRMS) > 1e-12 {
		t.Errorf("rms mismatch: plain=%v wrapped=%v", resPlain.FinalResidualRMS, resWrapped.FinalResidualRMS)
	}
	if len(resPlain.Changes) != len(resWrapped.Changes) {
		t.Errorf("changes count: plain=%d wrapped=%d", len(resPlain.Changes), len(resWrapped.Changes))
	}
}

func TestSolveJointWithSeedSkipsUnknownCPID(t *testing.T) {
	// A seeded id that doesn't appear in the problem must be skipped silently.
	// This guards against orchestration errors on the handler side dropping
	// the joint solve entirely just because one id is stale.
	cpTrueLat, cpTrueLng, cpTrueAlt := solver.ENUToLatLngAlt(75, 250, 5, gaugeLat, gaugeLng, 0)
	w := fourStationWorld(
		[]synth.TrueCP{{ID: "cp1", EstLat: cpTrueLat, EstLng: cpTrueLng, EstAlt: cpTrueAlt}},
		[][]int{{0, 1, 2, 3}},
	)
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}

	// Perturb a free station so joint has measurable work. Otherwise
	// initial residual is already at tolerance and the solver reports
	// Diverged spuriously (existing behavior unrelated to this test's
	// purpose).
	dLat, _ := offsetLatLng(0, 0.5)
	for i := range prob.Stations {
		if prob.Stations[i].Locks.Lat {
			continue
		}
		prob.Stations[i].Lat += dLat - gaugeLat
	}

	res, err := solver.SolveJointWithSeed(prob, []string{"does-not-exist"}, solver.Config{MaxIters: 80})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("should not diverge with unknown id: %+v", res)
	}
}

func TestSolveJointWithSeedTrivialJointAfterPreSolve(t *testing.T) {
	// Pre-solve refines the seeded CP from centroid to truth; the joint
	// phase then has nothing to do (already at residual tolerance). Result
	// must report Converged=true (not Diverged) so the writeback path
	// persists the pre-solve refinement.
	cpTrueLat, cpTrueLng, cpTrueAlt := solver.ENUToLatLngAlt(75, 250, 5, gaugeLat, gaugeLng, 0)
	w := fourStationWorld(
		[]synth.TrueCP{{ID: "cp1", EstLat: cpTrueLat, EstLng: cpTrueLng, EstAlt: cpTrueAlt}},
		[][]int{{0, 1, 2, 3}},
	)
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatal(err)
	}

	centroidLat, centroidLng := stationCentroid(prob.Stations)
	prob.ControlPoints[0].EstLat = centroidLat
	prob.ControlPoints[0].EstLng = centroidLng
	prob.ControlPoints[0].EstAlt = 0

	// No station / photo perturbation: only the seeded CP needs refinement.
	res, err := solver.SolveJointWithSeed(prob, []string{"cp1"}, solver.Config{MaxIters: 80})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("trivial-joint case should not be flagged Diverged: %+v", res)
	}
	if !res.Converged {
		t.Errorf("expected Converged=true after override; got %+v", res)
	}
	c := findCPChange(res.Changes, "cp1")
	if c == nil {
		t.Fatalf("expected control_point change for cp1; got %+v", res.Changes)
	}
	if got := c.After["est_lat"]; math.Abs(got-cpTrueLat) > 5e-6 {
		t.Errorf("After.est_lat: got %v want %v", got, cpTrueLat)
	}
	if got := c.After["est_lng"]; math.Abs(got-cpTrueLng) > 5e-6 {
		t.Errorf("After.est_lng: got %v want %v", got, cpTrueLng)
	}
}
