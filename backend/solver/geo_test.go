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
