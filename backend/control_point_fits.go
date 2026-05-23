package main

import (
	"math"
	"net/http"

	"github.com/bmander/panorama-builder/shared/geom"
	"github.com/bmander/panorama-builder/shared/wire"
)

// listControlPointFits returns the per-CP RMS angular residual of every
// observation against the CP's stored estimate, using the same residual
// kernel the joint solver minimizes. Surfaces a "two locations conflated
// into one CP" signal on the CP index. est_alt NULL is treated as 0 —
// matches the solver, so CPs without an altitude estimate still get a
// fit value.
func (s *Server) listControlPointFits(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT cp.id, cp.est_lat, cp.est_lng, COALESCE(cp.est_alt, 0),
		       st.id, st.lat, st.lng, st.alt,
		       p.photo_az, p.photo_tilt, p.photo_roll, p.size_rad, p.aspect,
		       p.dist_k1, p.dist_k2,
		       im.u, im.v
		FROM image_measurements im
		JOIN control_points cp ON cp.id = im.control_point_id
		JOIN photos         p  ON p.id = im.photo_id
		JOIN stations       st ON st.id = p.station_id
		WHERE cp.est_lat IS NOT NULL AND cp.est_lng IS NOT NULL`)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer rows.Close()

	type stationFrame struct {
		ecef  [3]float64
		basis geom.ENUBasis
	}
	stationCache := map[string]stationFrame{}
	cpECEF := map[string][3]float64{}

	type acc struct {
		sumSq float64
		count int
	}
	byCP := map[string]*acc{}

	for rows.Next() {
		var cpID, stID string
		var cpLat, cpLng, cpAlt float64
		var stLat, stLng, stAlt float64
		var pose wire.Pose
		var u, v float64
		if err := rows.Scan(&cpID, &cpLat, &cpLng, &cpAlt,
			&stID, &stLat, &stLng, &stAlt,
			&pose.PhotoAz, &pose.PhotoTilt, &pose.PhotoRoll, &pose.SizeRad, &pose.Aspect,
			&pose.K1, &pose.K2,
			&u, &v); err != nil {
			writeErrorFromDB(w, err)
			return
		}

		sf, ok := stationCache[stID]
		if !ok {
			sx, sy, sz := geom.LLAToECEF(stLat, stLng, stAlt)
			sf = stationFrame{ecef: [3]float64{sx, sy, sz}, basis: geom.LocalENUBasis(stLat, stLng)}
			stationCache[stID] = sf
		}
		cECEF, ok := cpECEF[cpID]
		if !ok {
			cx, cy, cz := geom.LLAToECEF(cpLat, cpLng, cpAlt)
			cECEF = [3]float64{cx, cy, cz}
			cpECEF[cpID] = cECEF
		}

		dE, dN, dU := geom.ProjectECEFDeltaToLocalENU(
			cECEF[0]-sf.ecef[0], cECEF[1]-sf.ecef[1], cECEF[2]-sf.ecef[2], sf.basis)
		dU += geom.RefractionK * (dE*dE + dN*dN) / (2 * sf.basis.Rlocal)
		azTgt, elTgt := geom.BearingENU(dE, dN, dU)
		azPred, elPred := geom.ProjectPOI(pose, u, v)
		azRow, elRow := geom.ResidualFromBearings(azPred, elPred, azTgt, elTgt)

		a, ok := byCP[cpID]
		if !ok {
			a = &acc{}
			byCP[cpID] = a
		}
		a.sumSq += azRow*azRow + elRow*elRow
		a.count++
	}
	if err := rows.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}

	out := ControlPointFits{ControlPoints: make([]ControlPointFit, 0, len(byCP))}
	for id, a := range byCP {
		rms := math.Sqrt(a.sumSq / float64(2*a.count))
		out.ControlPoints = append(out.ControlPoints, ControlPointFit{
			ID:               id,
			FitRmsRad:        rms,
			ObservationCount: a.count,
		})
	}
	writeJSON(w, http.StatusOK, out)
}
