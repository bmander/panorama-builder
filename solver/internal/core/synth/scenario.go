// Package synth builds ground-truth Problems for the solver's unit tests.
// All math is forward-only (no DB, no HTTP); a test seeds true positions +
// poses, asks Build to project CPs into photos to compute (u, v), then
// perturbs the resulting Problem before handing it to solver.Solve.
package synth

import (
	"fmt"
	"math"

	"github.com/bmander/panorama-builder/shared/geom"
	"github.com/bmander/panorama-builder/shared/wire"
)

// World is the ground-truth state: stations at true lat/lng, photos with
// true poses, CPs at true lat/lng/alt. Observations are derived in Build
// using geom.BearingFromStationToCP — the same WGS84 + refraction bearing
// model the solver uses for residuals — so a synthesized Problem has zero
// residual at truth and the post-perturbation solve converges back to it.
type World struct {
	Stations      []TrueStation
	Photos        []TruePhoto
	ControlPoints []TrueCP
	// VisibleIn lists, per CP index, the photo indices that should observe it.
	// Build runs InverseProjectToUV per (photo, cp) and skips any pair where
	// the CP falls outside [0, 1]^2 — but if a pair is in VisibleIn and falls
	// out, Build returns an error so test authors notice.
	VisibleIn [][]int
}

type TrueStation struct {
	ID       string
	Lat, Lng float64
	Locks    wire.StationLocks
}

type TruePhoto struct {
	ID        string
	StationID string
	Pose      wire.Pose
	Locks     wire.PhotoLocks
}

type TrueCP struct {
	ID                     string
	EstLat, EstLng, EstAlt float64
	Locks                  wire.CPLocks
}

// Build returns a Problem whose Observations are projections of the World's
// CPs through the World's photos using geom.BearingFromStationToCP — the
// same WGS84-ECEF + refraction bearing model the solver uses for residuals.
// The resulting Problem represents the "perfect" state — a solver run on it
// should converge with near-zero residual after at most one iteration.
// Tests then perturb fields before solving to verify recovery.
func Build(w World) (wire.Problem, error) {
	if len(w.Stations) == 0 {
		return wire.Problem{}, fmt.Errorf("synth.Build: no stations")
	}

	stationByID := make(map[string]TrueStation, len(w.Stations))
	for _, s := range w.Stations {
		stationByID[s.ID] = s
	}

	stations := make([]wire.Station, len(w.Stations))
	for i, s := range w.Stations {
		stations[i] = wire.Station{ID: s.ID, Lat: s.Lat, Lng: s.Lng, Locks: s.Locks}
	}
	photos := make([]wire.Photo, len(w.Photos))
	for i, p := range w.Photos {
		photos[i] = wire.Photo{ID: p.ID, StationID: p.StationID, Pose: p.Pose, Locks: p.Locks}
	}
	cps := make([]wire.ControlPoint, len(w.ControlPoints))
	for i, cp := range w.ControlPoints {
		cps[i] = wire.ControlPoint{
			ID: cp.ID, EstLat: cp.EstLat, EstLng: cp.EstLng,
			EstAlt: cp.EstAlt, Locks: cp.Locks,
		}
	}

	var observations []wire.Observation
	obsCounter := 0
	for cpIdx, photoIdxs := range w.VisibleIn {
		cp := w.ControlPoints[cpIdx]
		for _, pIdx := range photoIdxs {
			p := w.Photos[pIdx]
			st, ok := stationByID[p.StationID]
			if !ok {
				return wire.Problem{}, fmt.Errorf("synth.Build: photo[%d] references unknown station %q", pIdx, p.StationID)
			}
			az, el := geom.BearingFromStationToCP(st.Lat, st.Lng, 0, cp.EstLat, cp.EstLng, cp.EstAlt)
			u, v, ok := InverseProjectToUV(p.Pose, az, el)
			if !ok {
				return wire.Problem{}, fmt.Errorf("synth.Build: inverse projection failed for cp[%d]→photo[%d]", cpIdx, pIdx)
			}
			if u < 0 || u > 1 || v < 0 || v > 1 {
				return wire.Problem{}, fmt.Errorf("synth.Build: cp[%d] outside FOV of photo[%d] (u=%v v=%v)", cpIdx, pIdx, u, v)
			}
			obsCounter++
			observations = append(observations, wire.Observation{
				ID:             fmt.Sprintf("obs%04d", obsCounter),
				PhotoID:        p.ID,
				ControlPointID: cp.ID,
				U:              u,
				V:              v,
			})
		}
	}

	return wire.Problem{
		Stations:      stations,
		Photos:        photos,
		ControlPoints: cps,
		Observations:  observations,
	}, nil
}

// InverseProjectToUV finds (u, v) such that ProjectPOI(pose, u, v) == (az, el),
// using Newton's method with a numerical 2×2 Jacobian. Returns ok=false on
// singular Jacobian; (u, v) may fall outside [0, 1] if the target direction
// is outside the photo's FOV (caller checks).
func InverseProjectToUV(pose wire.Pose, az, el float64) (u, v float64, ok bool) {
	u, v = 0.5, 0.5
	const h = 1e-6
	for i := 0; i < 30; i++ {
		azG, elG := geom.ProjectPOI(pose, u, v)
		dAz := geom.WrapPi(az - azG)
		dEl := el - elG
		if math.Hypot(dAz, dEl) < 1e-13 {
			return u, v, true
		}
		a1, e1 := geom.ProjectPOI(pose, u+h, v)
		a2, e2 := geom.ProjectPOI(pose, u, v+h)
		jUu := geom.WrapPi(a1-azG) / h
		jVu := (e1 - elG) / h
		jUv := geom.WrapPi(a2-azG) / h
		jVv := (e2 - elG) / h
		det := jUu*jVv - jVu*jUv
		if math.Abs(det) < 1e-18 {
			return u, v, false
		}
		du := (dAz*jVv - dEl*jUv) / det
		dv := (dEl*jUu - dAz*jVu) / det
		u += du
		v += dv
	}
	return u, v, true
}
