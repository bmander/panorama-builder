package solver

import "math"

const (
	// Meters per degree latitude. Constant within ~0.5% across the globe.
	MPerDegLat = 111320.0
	REarth     = 6371000.0
)

// LatLngAltToENU projects (lat,lng,alt) into a local east-north-up meter
// frame anchored at (lat0,lng0,alt0). Flat-earth approximation: accurate
// to better than 1% within ~50 km of the origin.
func LatLngAltToENU(lat, lng, alt, lat0, lng0, alt0 float64) (e, n, u float64) {
	cosLat0 := math.Cos(lat0 * math.Pi / 180)
	e = (lng - lng0) * MPerDegLat * cosLat0
	n = (lat - lat0) * MPerDegLat
	u = alt - alt0
	return
}

// ENUToLatLngAlt is the inverse of LatLngAltToENU.
func ENUToLatLngAlt(e, n, u, lat0, lng0, alt0 float64) (lat, lng, alt float64) {
	cosLat0 := math.Cos(lat0 * math.Pi / 180)
	lat = lat0 + n/MPerDegLat
	lng = lng0 + e/(MPerDegLat*cosLat0)
	alt = alt0 + u
	return
}

// WrapPi wraps an angle to (-π, π].
func WrapPi(a float64) float64 {
	twoPi := 2 * math.Pi
	return math.Mod(math.Mod(a+math.Pi, twoPi)+twoPi, twoPi) - math.Pi
}

// BearingENU returns the viewer-frame (az, el) of a target direction expressed
// in ENU coords (target meters east/north/up from the camera). The viewer
// frame matches frontend/src/geo.ts:vecToAzAlt:
//
//	+X = east   (matches viewer-x via target_east → +x)
//	+Y = up
//	-Z = north  (camera's "forward" when az = 0)
//
// az is CCW from -Z; el is the elevation above the horizon.
func BearingENU(targetE, targetN, targetU float64) (az, el float64) {
	x := targetE
	y := targetU
	z := -targetN
	length := math.Sqrt(x*x + y*y + z*z)
	az = math.Atan2(-x, -z)
	if length == 0 {
		return az, 0
	}
	r := y / length
	if r > 1 {
		r = 1
	} else if r < -1 {
		r = -1
	}
	el = math.Asin(r)
	return
}
