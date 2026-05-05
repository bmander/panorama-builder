package main

import (
	"github.com/bmander/panorama-builder/backend/solver"
)

// meanStationLatLng returns the unweighted mean of the given stations'
// lat/lng. ok=false when stations is empty (caller decides what to do).
func meanStationLatLng(stations []solver.Station) (lat, lng float64, ok bool) {
	if len(stations) == 0 {
		return 0, 0, false
	}
	for _, st := range stations {
		lat += st.Lat
		lng += st.Lng
	}
	n := float64(len(stations))
	return lat / n, lng / n, true
}

// seedNullLocationCPs gives null-location CPs an initial position so the
// joint solver can refine them as free parameters; CPs with fewer than 2
// distinct contributing stations are dropped — a single ray can't constrain
// a 3D position. Observations referencing dropped CPs are removed too,
// otherwise the solver's CP-index lookup would silently point at the wrong
// row.
func seedNullLocationCPs(
	cps []solver.ControlPoint, nullLoc map[string]bool,
	obs []solver.Observation,
	photos []solver.Photo, stations []solver.Station,
) ([]solver.ControlPoint, []solver.Observation) {
	if len(nullLoc) == 0 {
		return cps, obs
	}

	photoStation := make(map[string]string, len(photos))
	for _, p := range photos {
		photoStation[p.ID] = p.StationID
	}
	stationByID := make(map[string]solver.Station, len(stations))
	for _, st := range stations {
		stationByID[st.ID] = st
	}

	cpStations := make(map[string]map[string]bool, len(nullLoc))
	for _, o := range obs {
		if !nullLoc[o.ControlPointID] {
			continue
		}
		if stID := photoStation[o.PhotoID]; stID != "" {
			set := cpStations[o.ControlPointID]
			if set == nil {
				set = map[string]bool{}
				cpStations[o.ControlPointID] = set
			}
			set[stID] = true
		}
	}

	drop := map[string]bool{}
	seedLat := map[string]float64{}
	seedLng := map[string]float64{}
	for cpID := range nullLoc {
		stIDs := cpStations[cpID]
		if len(stIDs) < 2 {
			drop[cpID] = true
			continue
		}
		contributing := make([]solver.Station, 0, len(stIDs))
		for stID := range stIDs {
			if st, ok := stationByID[stID]; ok {
				contributing = append(contributing, st)
			}
		}
		lat, lng, ok := meanStationLatLng(contributing)
		if !ok || len(contributing) < 2 {
			drop[cpID] = true
			continue
		}
		seedLat[cpID] = lat
		seedLng[cpID] = lng
	}

	keptCPs := make([]solver.ControlPoint, 0, len(cps))
	for _, cp := range cps {
		if drop[cp.ID] {
			continue
		}
		if nullLoc[cp.ID] {
			cp.EstLat = seedLat[cp.ID]
			cp.EstLng = seedLng[cp.ID]
		}
		keptCPs = append(keptCPs, cp)
	}

	keptObs := make([]solver.Observation, 0, len(obs))
	for _, o := range obs {
		if drop[o.ControlPointID] {
			continue
		}
		keptObs = append(keptObs, o)
	}

	return keptCPs, keptObs
}
