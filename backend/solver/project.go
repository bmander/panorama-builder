package solver

import "math"

// tiltClampEps keeps photo_tilt strictly inside (-π/2, π/2). Exactly ±π/2
// makes the local-X axis cross-product (-cz, _, cx) collapse to zero and
// causes the basis-construction to NaN.
const tiltClampEps = 1e-6

func clampTilt(t float64) float64 {
	const lo = -math.Pi/2 + tiltClampEps
	const hi = math.Pi/2 - tiltClampEps
	if t > hi {
		return hi
	}
	if t < lo {
		return lo
	}
	return t
}

// ProjectPOI returns the viewer-frame (az, el) direction of image-plane
// point (u, v) for a photo with the given pose. (u, v) is interpreted as
// the *observed* (distorted) pixel; when pose.K1/K2 are nonzero the function
// inverts Brown-Conrady to recover the corresponding undistorted direction.
//
// Build the photo's center direction from (az, alt), construct the pre-roll
// local-X / local-Y plane axes via cross products, apply photoRoll in the
// plane, project (u-0.5, v-0.5) on a unit-radius photo plane
// (W = 2·tan(sizeRad/2)), undistort, then convert the resulting world
// direction to az/el.
func ProjectPOI(pose Pose, u, v float64) (az, el float64) {
	azP := pose.PhotoAz
	altP := clampTilt(pose.PhotoTilt)
	roll := pose.PhotoRoll
	sizeRad := pose.SizeRad
	aspect := pose.Aspect

	ca, sa := math.Cos(altP), math.Sin(altP)
	caz, saz := math.Cos(azP), math.Sin(azP)
	cx := -ca * saz
	cy := sa
	cz := -ca * caz

	lxX := -cz
	lxZ := cx
	lxLen := math.Hypot(lxX, lxZ)
	if lxLen == 0 {
		lxLen = 1
	}
	baseXx := lxX / lxLen
	baseXz := lxZ / lxLen

	lyX := -cy * cx
	lyY := cz*cz + cx*cx
	lyZ := -cy * cz
	lyLen := math.Sqrt(lyX*lyX + lyY*lyY + lyZ*lyZ)
	if lyLen == 0 {
		lyLen = 1
	}
	baseYx := lyX / lyLen
	baseYy := lyY / lyLen
	baseYz := lyZ / lyLen

	cr, sr := math.Cos(roll), math.Sin(roll)
	localXx := cr*baseXx + sr*baseYx
	localXy := sr * baseYy // baseXy = 0 by construction
	localXz := cr*baseXz + sr*baseYz
	localYx := -sr*baseXx + cr*baseYx
	localYy := cr * baseYy
	localYz := -sr*baseXz + cr*baseYz

	W := 2 * math.Tan(sizeRad/2)
	H := W / aspect
	dx := (u - 0.5) * W
	dy := (v - 0.5) * H

	// Brown-Conrady inverse via fixed-point iteration: given distorted
	// (dx, dy), find the undistorted (x, y) such that (x, y)·(1+k1·r²+k2·r⁴)
	// = (dx, dy). Skipped (no-op) when both coefficients are zero.
	if pose.K1 != 0 || pose.K2 != 0 {
		xd, yd := dx, dy
		x, y := xd, yd
		for i := 0; i < 5; i++ {
			r2 := x*x + y*y
			f := 1 + pose.K1*r2 + pose.K2*r2*r2
			if f == 0 {
				break
			}
			x = xd / f
			y = yd / f
		}
		dx, dy = x, y
	}

	px := cx + dx*localXx + dy*localYx
	py := cy + dx*localXy + dy*localYy
	pz := cz + dx*localXz + dy*localYz

	length := math.Sqrt(px*px + py*py + pz*pz)
	az = math.Atan2(-px, -pz)
	if length == 0 {
		return az, 0
	}
	r := py / length
	if r > 1 {
		r = 1
	} else if r < -1 {
		r = -1
	}
	el = math.Asin(r)
	return
}
