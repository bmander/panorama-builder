package solver

import (
	"math"
	"testing"
)

func TestLatLngAltENURoundTrip(t *testing.T) {
	cases := []struct {
		name             string
		lat0, lng0, alt0 float64
		lat, lng, alt    float64
	}{
		{"near origin equator", 0, 0, 0, 0.001, 0.001, 5},
		{"mid-lat seattle", 47.61, -122.33, 100, 47.62, -122.34, 250},
		{"southern hemisphere", -33.87, 151.21, 12, -33.88, 151.22, 14},
		{"sub-meter", 47.61, -122.33, 100, 47.61 + 1e-7, -122.33 + 1e-7, 100.01},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e, n, u := LatLngAltToENU(c.lat, c.lng, c.alt, c.lat0, c.lng0, c.alt0)
			lat, lng, alt := ENUToLatLngAlt(e, n, u, c.lat0, c.lng0, c.alt0)
			if math.Abs(lat-c.lat) > 1e-12 {
				t.Errorf("lat round-trip drift: got %v want %v", lat, c.lat)
			}
			if math.Abs(lng-c.lng) > 1e-12 {
				t.Errorf("lng round-trip drift: got %v want %v", lng, c.lng)
			}
			if math.Abs(alt-c.alt) > 1e-12 {
				t.Errorf("alt round-trip drift: got %v want %v", alt, c.alt)
			}
		})
	}
}

func TestWrapPi(t *testing.T) {
	cases := []struct {
		in, want float64
	}{
		{0, 0},
		{math.Pi, math.Pi},
		{-math.Pi, math.Pi},
		{math.Pi + 0.1, -math.Pi + 0.1},
		{3 * math.Pi, math.Pi},
		{-3 * math.Pi, math.Pi},
	}
	for _, c := range cases {
		got := WrapPi(c.in)
		if math.Abs(WrapPi(got-c.want)) > 1e-12 {
			t.Errorf("WrapPi(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestBearingENUDueDirections(t *testing.T) {
	// 10 m due north → az = 0, el = 0.
	az, el := BearingENU(0, 10, 0)
	if math.Abs(az) > 1e-12 || math.Abs(el) > 1e-12 {
		t.Errorf("north: az=%v el=%v want 0,0", az, el)
	}
	// 10 m due east → az = -π/2 (compass-east is CCW-from-north = -90°).
	az, el = BearingENU(10, 0, 0)
	if math.Abs(az+math.Pi/2) > 1e-12 || math.Abs(el) > 1e-12 {
		t.Errorf("east: az=%v el=%v want -π/2,0", az, el)
	}
	// straight up → el = +π/2.
	_, el = BearingENU(0, 0, 10)
	if math.Abs(el-math.Pi/2) > 1e-12 {
		t.Errorf("up: el=%v want π/2", el)
	}
	// straight down → el = -π/2.
	_, el = BearingENU(0, 0, -10)
	if math.Abs(el+math.Pi/2) > 1e-12 {
		t.Errorf("down: el=%v want -π/2", el)
	}
}

func TestLLAECEFRoundTrip(t *testing.T) {
	cases := []struct {
		name          string
		lat, lng, alt float64
	}{
		{"equator prime meridian", 0, 0, 0},
		{"equator with alt", 0, 45, 1234.5},
		{"mid-lat seattle", 47.6097, -122.3331, 100},
		{"southern hemisphere", -33.87, 151.21, 12},
		{"high northern", 78.22, 15.65, -5},
		{"deep south", -78.22, -15.65, 2500},
		{"sub-meter delta", 47.6097, -122.3331, 100.001},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x, y, z := LLAToECEF(c.lat, c.lng, c.alt)
			lat, lng, alt := ECEFToLLA(x, y, z)
			if math.Abs(lat-c.lat) > 1e-9 {
				t.Errorf("lat: got %v want %v (Δ=%v)", lat, c.lat, lat-c.lat)
			}
			if math.Abs(lng-c.lng) > 1e-9 {
				t.Errorf("lng: got %v want %v (Δ=%v)", lng, c.lng, lng-c.lng)
			}
			if math.Abs(alt-c.alt) > 1e-3 {
				t.Errorf("alt: got %v want %v (Δ=%v)", alt, c.alt, alt-c.alt)
			}
		})
	}
}

func TestLocalENUBasisOrthonormal(t *testing.T) {
	cases := []struct{ lat, lng float64 }{
		{0, 0}, {47.61, -122.33}, {-33.87, 151.21}, {78.0, 15.0},
	}
	dot := func(a, b [3]float64) float64 {
		return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]
	}
	for _, c := range cases {
		b := LocalENUBasis(c.lat, c.lng)
		// Each axis is unit length.
		if math.Abs(dot(b.East, b.East)-1) > 1e-12 {
			t.Errorf("east not unit at (%v,%v): |east|²=%v", c.lat, c.lng, dot(b.East, b.East))
		}
		if math.Abs(dot(b.North, b.North)-1) > 1e-12 {
			t.Errorf("north not unit at (%v,%v): |north|²=%v", c.lat, c.lng, dot(b.North, b.North))
		}
		if math.Abs(dot(b.Up, b.Up)-1) > 1e-12 {
			t.Errorf("up not unit at (%v,%v): |up|²=%v", c.lat, c.lng, dot(b.Up, b.Up))
		}
		// Pairwise orthogonality.
		if math.Abs(dot(b.East, b.North)) > 1e-12 {
			t.Errorf("east·north ≠ 0 at (%v,%v): %v", c.lat, c.lng, dot(b.East, b.North))
		}
		if math.Abs(dot(b.East, b.Up)) > 1e-12 {
			t.Errorf("east·up ≠ 0 at (%v,%v): %v", c.lat, c.lng, dot(b.East, b.Up))
		}
		if math.Abs(dot(b.North, b.Up)) > 1e-12 {
			t.Errorf("north·up ≠ 0 at (%v,%v): %v", c.lat, c.lng, dot(b.North, b.Up))
		}
		// Rlocal is in the WGS84 sphere-of-mean-curvature ballpark (~6.36–6.40 Mm).
		if b.Rlocal < 6.35e6 || b.Rlocal > 6.40e6 {
			t.Errorf("Rlocal out of range at lat=%v: %v", c.lat, b.Rlocal)
		}
	}
}

func TestBearingFromStationToCPRefraction(t *testing.T) {
	// Two points at the same altitude (alt=10m) separated by 2 km of north.
	// Geometric drop = d²/(2R) ≈ 2000²/(2·6.37e6) ≈ 31.4 cm. Refraction
	// raises the apparent target by k·d²/(2R) = 0.14·31.4 cm ≈ 4.4 cm. So
	// the predicted elevation should be slightly negative (target appears
	// below the local horizon) but less negative than the pure geometric
	// drop would imply.
	const sLat, sLng = 47.6097, -122.3331
	const cAlt = 10.0
	cLat := sLat + 2000.0/MPerDegLat
	az, el := BearingFromStationToCP(sLat, sLng, cAlt, cLat, sLng, cAlt)

	// Azimuth: due north → 0.
	if math.Abs(az) > 1e-6 {
		t.Errorf("az: got %v want ~0 for due north", az)
	}
	// Pure geometric drop in radians ≈ d/(2R) = 1000/6.37e6 ≈ 1.57e-4.
	// With refraction k=0.14, apparent drop = 0.86·d/(2R) ≈ 1.35e-4.
	// elPred should be ≈ -1.35e-4. Allow 5% slack for the WGS84 vs
	// spherical Earth and the ellipsoidal vs planar projection.
	wantEl := -0.86 * 2000.0 / (2 * 6.371e6)
	if math.Abs(el-wantEl)/math.Abs(wantEl) > 0.05 {
		t.Errorf("el: got %v want ~%v (within 5%%)", el, wantEl)
	}
	// Sanity: refraction should make the predicted elevation less negative
	// than the no-refraction (pure geometric) drop.
	geometricDrop := -2000.0 / (2 * 6.371e6)
	if el <= geometricDrop {
		t.Errorf("refraction not raising apparent target: el=%v, geometricDrop=%v", el, geometricDrop)
	}
}

func TestProjectPOICenterMatchesPose(t *testing.T) {
	// (u, v) = (0.5, 0.5) is the photo center; az/el should equal photo_az/tilt.
	cases := []struct {
		az, tilt, roll float64
	}{
		{0, 0, 0},
		{1.2, 0.3, 0},
		{-0.8, -0.4, 0.5},
	}
	for _, c := range cases {
		pose := Pose{PhotoAz: c.az, PhotoTilt: c.tilt, PhotoRoll: c.roll, SizeRad: math.Pi / 6, Aspect: 1.5}
		az, el := ProjectPOI(pose, 0.5, 0.5)
		if math.Abs(WrapPi(az-c.az)) > 1e-12 {
			t.Errorf("center az: got %v want %v", az, c.az)
		}
		if math.Abs(el-c.tilt) > 1e-12 {
			t.Errorf("center el: got %v want %v", el, c.tilt)
		}
	}
}
