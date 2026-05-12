package solver_test

import (
	"math"
	"testing"

	"github.com/bmander/panorama-builder/backend/solver"
	"github.com/bmander/panorama-builder/backend/solver/synth"
)

// TestCurvatureBiasGoneOnLongBaseline targets the systematic CP-altitude
// bias that the old flat-tangent-plane solver introduced for multi-km
// baselines. Two stations 5 km apart on the same parallel both observe a
// CP midway between them at the same physical altitude. With the
// curvature-aware residual (per-station ENU + WGS84 ECEF + refraction),
// synth.Build produces self-consistent observations; the solver should
// recover the CP's true altitude to well under a centimeter.
//
// (For reference, the old flat model would have biased the recovered alt
// downward by ~(1−k)·(2500)²/(2·6.371e6) ≈ 84 cm — a number that motivated
// this whole change.)
func TestCurvatureBiasGoneOnLongBaseline(t *testing.T) {
	const baseLat = 47.6097
	const baseLng = -122.3331
	const cpAlt = 0.0

	// 5 km E–W baseline. cpLng is the midpoint.
	const halfBaselineM = 2500.0
	cosLat := math.Cos(baseLat * math.Pi / 180)
	dLng := halfBaselineM / (solver.MPerDegLat * cosLat)
	stALng := baseLng - dLng
	stBLng := baseLng + dLng
	cpLng := baseLng

	// CP is 200 m north of the baseline so both stations have a real
	// triangulation (otherwise the rays are colinear and the depth is
	// unobservable).
	cpLat := baseLat + 200.0/solver.MPerDegLat

	w := synth.World{
		Stations: []synth.TrueStation{
			{ID: "stA", Lat: baseLat, Lng: stALng,
				Locks: solver.StationLocks{Lat: true, Lng: true, Alt: true}},
			{ID: "stB", Lat: baseLat, Lng: stBLng,
				Locks: solver.StationLocks{Lat: true, Lng: true, Alt: true}},
		},
		Photos: []synth.TruePhoto{
			// Each photo points roughly toward the CP (azimuth toward NE for stA,
			// NW for stB). 120° FOV is more than wide enough for the geometry.
			{ID: "phA", StationID: "stA",
				Pose: solver.Pose{
					PhotoAz: photoAzToward(baseLat, stALng, cpLat, cpLng),
					SizeRad: 2 * math.Pi / 3, Aspect: 1.5,
				},
				Locks: solver.PhotoLocks{
					PhotoAz: true, PhotoTilt: true, PhotoRoll: true, SizeRad: true,
				}},
			{ID: "phB", StationID: "stB",
				Pose: solver.Pose{
					PhotoAz: photoAzToward(baseLat, stBLng, cpLat, cpLng),
					SizeRad: 2 * math.Pi / 3, Aspect: 1.5,
				},
				Locks: solver.PhotoLocks{
					PhotoAz: true, PhotoTilt: true, PhotoRoll: true, SizeRad: true,
				}},
		},
		ControlPoints: []synth.TrueCP{
			{ID: "cp1", EstLat: cpLat, EstLng: cpLng, EstAlt: cpAlt},
		},
		VisibleIn: [][]int{{0, 1}},
	}
	prob, err := synth.Build(w)
	if err != nil {
		t.Fatalf("synth.Build: %v", err)
	}

	// Perturb the CP's altitude away from truth so the solver has work.
	prob.ControlPoints[0].EstAlt = cpAlt + 5.0

	res, err := solver.Solve(prob, solver.Config{
		Mode: solver.ModeSingleControlPoint, FocusID: "cp1", MaxIters: 80,
	})
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if res.Diverged {
		t.Fatalf("should not diverge: %+v", res)
	}
	if len(res.Changes) != 1 || res.Changes[0].Kind != "control_point" {
		t.Fatalf("expected one CP change; got %+v", res.Changes)
	}
	gotAlt := res.Changes[0].After["est_alt"]
	// With the curvature-aware solver, the recovered altitude should be
	// within a centimeter of truth. The old flat-tangent-plane solver
	// would land ~84 cm low.
	if math.Abs(gotAlt-cpAlt) > 0.01 {
		t.Errorf("CP alt bias: got %v want %v (Δ=%v m)", gotAlt, cpAlt, gotAlt-cpAlt)
	}
}

// photoAzToward returns the great-circle bearing (in radians, viewer-frame
// CCW from north) from a station to a target lat/lng. Used to pre-aim the
// synthetic photo so the CP lands inside the FOV.
func photoAzToward(sLat, sLng, tLat, tLng float64) float64 {
	az, _ := solver.BearingFromStationToCP(sLat, sLng, 0, tLat, tLng, 0)
	return az
}
