package solver

import "testing"

// Direct unit tests for applyAutoLocks — keeping these tight to the
// derivation so a regression here surfaces before the bigger integration
// tests can drift around it.

func TestApplyAutoLocksZeroObs(t *testing.T) {
	p := Problem{
		Stations: []Station{{ID: "s1"}},
		Photos:   []Photo{{ID: "p1", StationID: "s1"}},
	}
	applyAutoLocks(&p)
	got := p.Photos[0].Locks
	want := PhotoLocks{PhotoAz: true, PhotoTilt: true, PhotoRoll: true, SizeRad: true, K1: true, K2: true}
	if got != want {
		t.Errorf("photo locks: got %+v, want %+v", got, want)
	}
	sg := p.Stations[0].Locks
	if !sg.Lat || !sg.Lng || !sg.Alt {
		t.Errorf("station locks at 0 obs should all auto-lock; got %+v", sg)
	}
}

func TestApplyAutoLocksOneObs(t *testing.T) {
	p := Problem{
		Stations: []Station{{ID: "s1"}},
		Photos:   []Photo{{ID: "p1", StationID: "s1"}},
		Observations: []Observation{
			{ID: "o1", PhotoID: "p1", ControlPointID: "cp1", U: 0.5, V: 0.5},
		},
	}
	applyAutoLocks(&p)
	got := p.Photos[0].Locks
	// 1 obs: az and tilt unlock (threshold 1); roll, fov, k1, k2 stay locked.
	if got.PhotoAz {
		t.Errorf("photoAz should be unlocked at 1 obs; got %+v", got)
	}
	if got.PhotoTilt {
		t.Errorf("photoTilt should be unlocked at 1 obs; got %+v", got)
	}
	if !got.PhotoRoll {
		t.Errorf("photoRoll should be auto-locked at 1 obs; got %+v", got)
	}
	if !got.SizeRad {
		t.Errorf("sizeRad should be auto-locked at 1 obs; got %+v", got)
	}
	if !got.K1 || !got.K2 {
		t.Errorf("k1/k2 should be auto-locked at 1 obs; got %+v", got)
	}
}

// TestSolveWithOneObsDoesNotMoveRoll runs an actual joint solve on a
// 1-observation problem and verifies that roll (auto-locked at this count)
// stays put end-to-end — buildContext → Ceres → composeChanges. Covers the
// integration the unit tests above can't.
func TestSolveWithOneObsDoesNotMoveRoll(t *testing.T) {
	const gLat, gLng = 47.6097, -122.3331
	cpLat, cpLng, cpAlt := ENUToLatLngAlt(0, 50, 0, gLat, gLng, 0)
	// One observation, well inside the FOV (90° H × ~67° V).
	prob := Problem{
		Stations: []Station{
			{ID: "s1", Lat: gLat, Lng: gLng, Alt: 0,
				Locks: StationLocks{Lat: true, Lng: true, Alt: true}},
			{ID: "s2", Lat: gLat, Lng: gLng + 0.0001, Alt: 0,
				Locks: StationLocks{Lat: true, Lng: true, Alt: true}},
		},
		Photos: []Photo{
			{ID: "p1", StationID: "s1", Pose: Pose{
				PhotoAz: 0, PhotoTilt: 0, PhotoRoll: 0.1, // deliberately non-zero
				SizeRad: 1.5708, Aspect: 1.5,
			}},
		},
		ControlPoints: []ControlPoint{
			{ID: "cp1", EstLat: cpLat, EstLng: cpLng, EstAlt: cpAlt,
				Locks: CPLocks{EstLat: true, EstLng: true, EstAlt: true}},
		},
		Observations: []Observation{
			{ID: "o1", PhotoID: "p1", ControlPointID: "cp1", U: 0.5, V: 0.5},
		},
	}
	initialRoll := prob.Photos[0].Pose.PhotoRoll
	res, err := Solve(prob, Config{Mode: ModeJoint})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	for _, c := range res.Changes {
		if c.Kind != "photo" || c.ID != "p1" {
			continue
		}
		if v, ok := c.After["photo_roll"]; ok {
			t.Errorf("photo_roll moved (auto-locked at 1 obs): initial=%v after=%v", initialRoll, v)
		}
	}
}

// Same scenario as above but through SolveJointWithSeed (what the prod
// handler picks when any CP has no location). The pre-solve runs in
// ModeSingleControlPoint (which fully locks photos) and then a ModeJoint
// solve runs through buildContext again — both must respect the auto-lock.
func TestSolveJointWithSeedOneObsDoesNotMoveRoll(t *testing.T) {
	const gLat, gLng = 47.6097, -122.3331
	cpLat, cpLng, cpAlt := ENUToLatLngAlt(0, 50, 0, gLat, gLng, 0)
	prob := Problem{
		Stations: []Station{
			{ID: "s1", Lat: gLat, Lng: gLng, Alt: 0,
				Locks: StationLocks{Lat: true, Lng: true, Alt: true}},
			{ID: "s2", Lat: gLat, Lng: gLng + 0.0001, Alt: 0,
				Locks: StationLocks{Lat: true, Lng: true, Alt: true}},
		},
		Photos: []Photo{
			{ID: "p1", StationID: "s1", Pose: Pose{
				PhotoAz: 0, PhotoTilt: 0, PhotoRoll: 0.1,
				SizeRad: 1.5708, Aspect: 1.5,
			}},
		},
		ControlPoints: []ControlPoint{
			{ID: "cp1", EstLat: cpLat, EstLng: cpLng, EstAlt: cpAlt,
				Locks: CPLocks{EstLat: true, EstLng: true, EstAlt: true}},
		},
		Observations: []Observation{
			{ID: "o1", PhotoID: "p1", ControlPointID: "cp1", U: 0.5, V: 0.5},
		},
	}
	res, err := SolveJointWithSeed(prob, nil, Config{})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	for _, c := range res.Changes {
		if c.Kind != "photo" || c.ID != "p1" {
			continue
		}
		if v, ok := c.After["photo_roll"]; ok {
			t.Errorf("photo_roll moved through SolveJointWithSeed at 1 obs: after=%v", v)
		}
	}
}

func TestApplyAutoLocksHonorsManualLock(t *testing.T) {
	p := Problem{
		Stations: []Station{{ID: "s1"}},
		Photos: []Photo{{
			ID: "p1", StationID: "s1",
			Locks: PhotoLocks{PhotoAz: true}, // user manually locked
		}},
		Observations: []Observation{
			{ID: "o1", PhotoID: "p1", ControlPointID: "cp1"},
			{ID: "o2", PhotoID: "p1", ControlPointID: "cp2"},
			{ID: "o3", PhotoID: "p1", ControlPointID: "cp3"},
			{ID: "o4", PhotoID: "p1", ControlPointID: "cp4"},
			{ID: "o5", PhotoID: "p1", ControlPointID: "cp5"},
		},
	}
	applyAutoLocks(&p)
	got := p.Photos[0].Locks
	// 5 obs unlocks everything via auto; manual on PhotoAz stays in force.
	if !got.PhotoAz {
		t.Errorf("manual lock_photo_az must survive auto-lock; got %+v", got)
	}
	if got.PhotoTilt || got.PhotoRoll || got.SizeRad || got.K1 || got.K2 {
		t.Errorf("with 5 obs only manual locks should remain; got %+v", got)
	}
}
