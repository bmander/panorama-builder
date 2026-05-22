//go:build !noceres

package solver_test

import (
	"fmt"
	"math"
	"math/rand"
	"testing"

	"github.com/bmander/panorama-builder/backend/solver"
	"github.com/bmander/panorama-builder/backend/solver/synth"
)

// buildJointBenchWorld builds a synthetic joint-mode problem at roughly the
// scale the user reports as bogged down: 15 stations × 50 CPs, with a few
// photos per station and CPs visible across multiple stations.
//
// Geometry: stations on a 3×5 grid spaced 50m apart. Each station has 4
// photos at azimuths 0, π/2, π, 3π/2 with 90° FOV (covers full 360°). CPs
// are scattered uniformly in a 400m × 400m square centered on the grid; the
// visibility pass keeps any (cp, photo) pair where the projection lands
// inside [0,1]².
func buildJointBenchWorld(stationCount, cpCount int, seed int64) synth.World {
	r := rand.New(rand.NewSource(seed))

	const spacing = 50.0
	const cols = 5

	stations := make([]synth.TrueStation, stationCount)
	for i := 0; i < stationCount; i++ {
		col := i % cols
		row := i / cols
		e := float64(col-cols/2) * spacing
		n := float64(row-1) * spacing
		lat, lng := offsetLatLng(e, n)
		s := synth.TrueStation{ID: fmt.Sprintf("st%02d", i), Lat: lat, Lng: lng}
		// First two stations fully locked (gauge requirement).
		if i < 2 {
			s.Locks = solver.StationLocks{Lat: true, Lng: true, Alt: true}
		}
		stations[i] = s
	}

	const photosPerStation = 4
	photos := make([]synth.TruePhoto, 0, stationCount*photosPerStation)
	for i := 0; i < stationCount; i++ {
		for k := 0; k < photosPerStation; k++ {
			az := float64(k) * math.Pi / 2
			photos = append(photos, synth.TruePhoto{
				ID:        fmt.Sprintf("p%02d_%d", i, k),
				StationID: stations[i].ID,
				Pose:      basicPose(az),
			})
		}
	}

	const span = 200.0 // half-extent of CP scatter, in meters
	cps := make([]synth.TrueCP, cpCount)
	for i := 0; i < cpCount; i++ {
		e := (r.Float64()*2 - 1) * span
		n := (r.Float64()*2 - 1) * span
		lat, lng := offsetLatLng(e, n)
		cps[i] = synth.TrueCP{
			ID:     fmt.Sprintf("cp%03d", i),
			EstLat: lat, EstLng: lng,
			EstAlt: r.Float64() * 5,
		}
	}

	visibleIn := make([][]int, cpCount)
	for ci, cp := range cps {
		for pi, p := range photos {
			st := stationsByID(stations, p.StationID)
			az, el := solver.BearingFromStationToCP(st.Lat, st.Lng, 0, cp.EstLat, cp.EstLng, cp.EstAlt)
			u, v, ok := synth.InverseProjectToUV(p.Pose, az, el)
			if !ok {
				continue
			}
			if u <= 0 || u >= 1 || v <= 0 || v >= 1 {
				continue
			}
			visibleIn[ci] = append(visibleIn[ci], pi)
		}
	}

	return synth.World{
		Stations:      stations,
		Photos:        photos,
		ControlPoints: cps,
		VisibleIn:     visibleIn,
	}
}

func stationsByID(ss []synth.TrueStation, id string) synth.TrueStation {
	for _, s := range ss {
		if s.ID == id {
			return s
		}
	}
	panic("no such station: " + id)
}

// perturbForBench shifts a few free parameters off truth so the solver has
// nontrivial work to do. Without this the first iteration converges and we
// would only measure constant overhead.
func perturbForBench(p *solver.Problem, seed int64) {
	r := rand.New(rand.NewSource(seed + 1))
	for i := range p.Photos {
		p.Photos[i].Pose.PhotoAz += (r.Float64()*2 - 1) * 0.05 // ±~3°
		p.Photos[i].Pose.PhotoTilt += (r.Float64()*2 - 1) * 0.02
	}
	for i := range p.Stations {
		if p.Stations[i].Locks.Lat || p.Stations[i].Locks.Lng {
			continue
		}
		// Nudge ~1m in lat/lng for unlocked stations.
		p.Stations[i].Lat += (r.Float64()*2 - 1) * 1e-5
		p.Stations[i].Lng += (r.Float64()*2 - 1) * 1e-5
	}
	for i := range p.ControlPoints {
		p.ControlPoints[i].EstLat += (r.Float64()*2 - 1) * 5e-6
		p.ControlPoints[i].EstLng += (r.Float64()*2 - 1) * 5e-6
		p.ControlPoints[i].EstAlt += (r.Float64()*2 - 1) * 1
	}
}

func BenchmarkSolveJoint15x50(b *testing.B) {
	w := buildJointBenchWorld(15, 50, 42)
	probTemplate, err := synth.Build(w)
	if err != nil {
		b.Fatal(err)
	}
	b.Logf("stations=%d photos=%d cps=%d obs=%d",
		len(probTemplate.Stations), len(probTemplate.Photos),
		len(probTemplate.ControlPoints), len(probTemplate.Observations))

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Deep-copy by re-building, since Solve mutates indirectly via the
		// caller's diff write-back pattern (the in-memory slices are not
		// touched, but the perturbation is what we want to A/B).
		p := cloneProblem(probTemplate)
		perturbForBench(&p, int64(i))
		_, err := solver.Solve(p, solver.Config{Mode: solver.ModeJoint, MaxIters: 50})
		if err != nil {
			b.Fatal(err)
		}
	}
}

// Mirror of the prod cap on the Solve dialog (frontend/src/solve-actions.ts).
// At the user's reported scale this is the configuration that bogs down.
func BenchmarkSolveJoint15x50_MaxIters200(b *testing.B) {
	w := buildJointBenchWorld(15, 50, 42)
	probTemplate, err := synth.Build(w)
	if err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p := cloneProblem(probTemplate)
		perturbForBench(&p, int64(i))
		_, err := solver.Solve(p, solver.Config{Mode: solver.ModeJoint, MaxIters: 200})
		if err != nil {
			b.Fatal(err)
		}
	}
}

func cloneProblem(p solver.Problem) solver.Problem {
	out := solver.Problem{
		Stations:      append([]solver.Station(nil), p.Stations...),
		Photos:        append([]solver.Photo(nil), p.Photos...),
		ControlPoints: append([]solver.ControlPoint(nil), p.ControlPoints...),
		Observations:  append([]solver.Observation(nil), p.Observations...),
	}
	return out
}
