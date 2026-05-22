package solver

import "math"

const (
	// Meters per degree latitude. Constant within ~0.5% across the globe.
	// Retained for the legacy LatLngAltToENU helper used by tests and
	// solve_seeded.go's diff-threshold scaling.
	MPerDegLat = 111320.0
	REarth     = 6371000.0

	// WGS84 ellipsoid constants. The solver works in ECEF with these so
	// long-baseline geometry is exact (modulo geoid undulation, which we do
	// not model — alt is treated as ellipsoidal height).
	WGS84a  = 6378137.0
	WGS84f  = 1.0 / 298.257223563
	WGS84e2 = WGS84f * (2 - WGS84f) // first eccentricity squared

	// RefractionK is the standard surveyor's atmospheric refraction
	// coefficient. Light bends slightly back toward the surface, so a target
	// at distance d appears higher than straight-line geometry by
	// k·d²/(2·R_local) in vertical drop. Hard-coded; expose via Config only
	// if a future use case needs it.
	RefractionK = 0.14
)

// ENUBasis caches the unit basis vectors of a local east-north-up tangent
// frame, expressed in ECEF, plus the local mean radius of curvature used by
// the refraction correction. Built once per station/CP at solve start.
type ENUBasis struct {
	East   [3]float64
	North  [3]float64
	Up     [3]float64
	Rlocal float64
}

// LatLngAltToENU projects (lat,lng,alt) into a local east-north-up meter
// frame anchored at (lat0,lng0,alt0). Flat-earth approximation: accurate
// to better than 1% within ~50 km of the origin. Retained for unit tests
// and for solve_seeded.go's degree-threshold scaling; the solver residual
// no longer uses this — see BearingFromStationToCP for the WGS84 path.
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

// LLAToECEF converts WGS84 geodetic (lat°, lng°, alt m above the ellipsoid)
// to Earth-Centered Earth-Fixed Cartesian meters.
func LLAToECEF(latDeg, lngDeg, alt float64) (x, y, z float64) {
	lat := latDeg * math.Pi / 180
	lng := lngDeg * math.Pi / 180
	sinLat, cosLat := math.Sincos(lat)
	sinLng, cosLng := math.Sincos(lng)
	N := WGS84a / math.Sqrt(1-WGS84e2*sinLat*sinLat)
	x = (N + alt) * cosLat * cosLng
	y = (N + alt) * cosLat * sinLng
	z = (N*(1-WGS84e2) + alt) * sinLat
	return
}

// ECEFToLLA inverts LLAToECEF using Bowring's closed-form approximation.
// Accurate to a few millimeters for terrestrial altitudes (|alt| < 100 km),
// which is well inside the project's regime.
func ECEFToLLA(x, y, z float64) (latDeg, lngDeg, alt float64) {
	a := WGS84a
	b := a * (1 - WGS84f)
	e2 := WGS84e2
	ep2 := (a*a - b*b) / (b * b)

	p := math.Sqrt(x*x + y*y)
	if p == 0 {
		// Polar singularity: lat is ±90°, lng undefined; pick lng=0.
		latDeg = 90
		if z < 0 {
			latDeg = -90
		}
		lngDeg = 0
		alt = math.Abs(z) - b
		return
	}
	theta := math.Atan2(z*a, p*b)
	sinTheta, cosTheta := math.Sincos(theta)
	lat := math.Atan2(
		z+ep2*b*sinTheta*sinTheta*sinTheta,
		p-e2*a*cosTheta*cosTheta*cosTheta,
	)
	lng := math.Atan2(y, x)
	sinLat, cosLat := math.Sincos(lat)
	N := a / math.Sqrt(1-e2*sinLat*sinLat)
	alt = p/cosLat - N
	return lat * 180 / math.Pi, lng * 180 / math.Pi, alt
}

// LocalENUBasis returns the east/north/up unit vectors in ECEF for the
// local tangent plane at (lat°, lng°), plus the local mean radius of
// curvature √(M·N) for the refraction term.
func LocalENUBasis(latDeg, lngDeg float64) ENUBasis {
	lat := latDeg * math.Pi / 180
	lng := lngDeg * math.Pi / 180
	sinLat, cosLat := math.Sincos(lat)
	sinLng, cosLng := math.Sincos(lng)
	return ENUBasis{
		East:   [3]float64{-sinLng, cosLng, 0},
		North:  [3]float64{-sinLat * cosLng, -sinLat * sinLng, cosLat},
		Up:     [3]float64{cosLat * cosLng, cosLat * sinLng, sinLat},
		Rlocal: localMeanRadius(sinLat),
	}
}

// localMeanRadius returns √(M·N) at the given sin(lat). M is the meridional
// radius of curvature; N is the prime-vertical radius. Their geometric mean
// is the standard "local Earth radius" used in surveying for the curvature/
// refraction drop formula.
func localMeanRadius(sinLat float64) float64 {
	denom := 1 - WGS84e2*sinLat*sinLat
	M := WGS84a * (1 - WGS84e2) / math.Pow(denom, 1.5)
	N := WGS84a / math.Sqrt(denom)
	return math.Sqrt(M * N)
}

// ApplyOffsetECEF adds a local-ENU displacement (eastM, northM, upM) at the
// origin's tangent plane (encoded in basis) to an ECEF position. Used by the
// solver to materialize an entity's effective ECEF at residual time from
// (origin_ECEF, slot_offset).
func ApplyOffsetECEF(originECEF [3]float64, basis ENUBasis, eastM, northM, upM float64) (x, y, z float64) {
	x = originECEF[0] + eastM*basis.East[0] + northM*basis.North[0] + upM*basis.Up[0]
	y = originECEF[1] + eastM*basis.East[1] + northM*basis.North[1] + upM*basis.Up[1]
	z = originECEF[2] + eastM*basis.East[2] + northM*basis.North[2] + upM*basis.Up[2]
	return
}

// ProjectECEFDeltaToLocalENU resolves an ECEF vector into the (east, north,
// up) components of the given local tangent frame.
func ProjectECEFDeltaToLocalENU(dx, dy, dz float64, basis ENUBasis) (dE, dN, dU float64) {
	dE = dx*basis.East[0] + dy*basis.East[1] + dz*basis.East[2]
	dN = dx*basis.North[0] + dy*basis.North[1] + dz*basis.North[2]
	dU = dx*basis.Up[0] + dy*basis.Up[1] + dz*basis.Up[2]
	return
}

// BearingFromStationToCP returns the (az, el) of the line-of-sight from a
// station to a control point in the station's own local ENU frame, with
// the k=0.14 atmospheric refraction correction folded into elevation.
func BearingFromStationToCP(sLat, sLng, sAlt, cLat, cLng, cAlt float64) (az, el float64) {
	sx, sy, sz := LLAToECEF(sLat, sLng, sAlt)
	cx, cy, cz := LLAToECEF(cLat, cLng, cAlt)
	basis := LocalENUBasis(sLat, sLng)
	dE, dN, dU := ProjectECEFDeltaToLocalENU(cx-sx, cy-sy, cz-sz, basis)
	dU += RefractionK * (dE*dE + dN*dN) / (2 * basis.Rlocal)
	return BearingENU(dE, dN, dU)
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

// minCosEl floors cos(el_target) so the polar singularity in the
// bearing-residual weighting stays bounded.
const minCosEl = 1e-6

// ResidualFromBearings combines predicted and target viewer-frame
// directions into the two-row angular residual the solver minimizes,
// matching the math the C++ cost functor in cost_functor.h implements.
// The az row is weighted by cos(el_target) so 1° at the horizon weighs
// more arc-length than 1° near the zenith; the floor on cos(el) keeps
// the polar singularity bounded. Exported for control_point_fits.go,
// which fits per-CP surfaces using the same residual definition.
func ResidualFromBearings(azPred, elPred, azTgt, elTgt float64) (azRow, elRow float64) {
	cosEl := math.Cos(elTgt)
	if math.Abs(cosEl) < minCosEl {
		cosEl = math.Copysign(minCosEl, cosEl)
		if cosEl == 0 {
			cosEl = minCosEl
		}
	}
	return WrapPi(azPred-azTgt) * cosEl, elPred - elTgt
}
