// Mirror of frontend/src/geo.ts (bearingFromLocation, viewerAzToBearing) so
// the backend can run viewshed checks without round-tripping pose data to
// the client. Conventions match the frontend: bearings are degrees CW from
// north; viewer-azimuth is radians CCW from -Z.

package main

import "math"

func bearingDeg(lat1, lng1, lat2, lng2 float64) float64 {
	phi1 := lat1 * math.Pi / 180
	phi2 := lat2 * math.Pi / 180
	dLambda := (lng2 - lng1) * math.Pi / 180
	y := math.Sin(dLambda) * math.Cos(phi2)
	x := math.Cos(phi1)*math.Sin(phi2) - math.Sin(phi1)*math.Cos(phi2)*math.Cos(dLambda)
	return math.Atan2(y, x) * 180 / math.Pi
}

func viewerAzToBearingDeg(az float64) float64 {
	return -az * 180 / math.Pi
}

// photoAz is unbounded (the user can rotate past ±π), so wrap twice to land
// in (-180, 180] before comparing to half-FOV. math.Mod can return a
// negative result when its first arg is negative — the second Mod fixes it.
func inHorizontalViewshed(stLat, stLng, cpLat, cpLng, photoAz, sizeRad float64) bool {
	target := bearingDeg(stLat, stLng, cpLat, cpLng)
	center := viewerAzToBearingDeg(photoAz)
	diff := math.Mod(math.Mod(target-center, 360)+540, 360) - 180
	return math.Abs(diff) <= sizeRad*180/math.Pi/2
}
