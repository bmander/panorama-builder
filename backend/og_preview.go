package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"io"
	"math"
	"net/http"
	"path/filepath"
	"strconv"
)

// Dynamic Open Graph "social card" images for /world deep links. A crawler
// fetching /world?sta=&az=&alt=&fov=... gets HTML whose og:image points here
// (see og_world.go); this handler reprojects the linked photo to match the
// view and returns a 1200x630 JPEG showing the section being linked to.
//
// READ-ONLY: this derives an image from existing rows + blob bytes. It does
// not mutate shared state, so the requireSession/recordOp trust-model rules
// (CLAUDE.md) do not apply here, same as getBlob / getBlobPreview.

const (
	ogCardW    = 1200
	ogCardH    = 630
	ogJPEGQ    = 85
	ogCacheVer = "v1" // bump to invalidate all cached cards after a math change
	// fallbackCard is served (via 302) when no photo crop can be produced.
	// Matches the static og:image default in the HTML head.
	fallbackCard = "/assets/apple-touch-icon.png"
)

// Mirrors the frontend clamps so the crop frames the same region the viewer
// shows (viewer.ts: PITCH_LIMIT, FOV_MIN, FOV_MAX).
const (
	ogPitchLimit = math.Pi/2 - 0.01 // ~89.43°
	ogFovMinDeg  = 2.0
	ogFovMaxDeg  = 100.0
	overlayR     = 100.0 // OVERLAY_R in overlay-photos.ts
)

type vec3 struct{ x, y, z float64 }

func (a vec3) add(b vec3) vec3      { return vec3{a.x + b.x, a.y + b.y, a.z + b.z} }
func (a vec3) sub(b vec3) vec3      { return vec3{a.x - b.x, a.y - b.y, a.z - b.z} }
func (a vec3) scale(s float64) vec3 { return vec3{a.x * s, a.y * s, a.z * s} }
func (a vec3) dot(b vec3) float64   { return a.x*b.x + a.y*b.y + a.z*b.z }
func (a vec3) cross(b vec3) vec3 {
	return vec3{a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x}
}
func (a vec3) norm() vec3 {
	l := math.Sqrt(a.dot(a))
	if l == 0 {
		return a
	}
	return a.scale(1 / l)
}

// rotYX applies Rx(alt) then Ry(az) to v, matching dirFromAzAlt's axis-angle
// order and the camera's YXZ rotation order in viewer.ts (roll = 0).
func rotYX(az, alt float64, v vec3) vec3 {
	// Rotate about X by alt.
	ca, sa := math.Cos(alt), math.Sin(alt)
	v = vec3{v.x, v.y*ca - v.z*sa, v.y*sa + v.z*ca}
	// Rotate about Y by az.
	cz, sz := math.Cos(az), math.Sin(az)
	return vec3{v.x*cz + v.z*sz, v.y, -v.x*sz + v.z*cz}
}

// dirFromAzAlt is the world-space view direction for (az, alt), identical to
// the frontend helper of the same name.
func dirFromAzAlt(az, alt float64) vec3 { return rotYX(az, alt, vec3{0, 0, -1}) }

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func degToRad(d float64) float64 { return d * math.Pi / 180 }

// parseFloatParam reads a finite float query param, optionally range-checked.
// Mirrors the frontend parseUrlFloat (route-state.ts).
func parseFloatParam(raw string, validate func(float64) bool) (float64, bool) {
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	if validate != nil && !validate(v) {
		return 0, false
	}
	return v, true
}

func (s *Server) getOgPreview(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sta := q.Get("sta")
	azDeg, okAz := parseFloatParam(q.Get("az"), nil)
	altDeg, okAlt := parseFloatParam(q.Get("alt"), func(v float64) bool { return math.Abs(v) <= 90 })
	fovDeg, okFov := parseFloatParam(q.Get("fov"), func(v float64) bool { return v > 0 && v < 180 })
	if !validID(sta) || !okAz || !okAlt || !okFov {
		s.serveFallbackCard(w, r)
		return
	}

	ctx := r.Context()
	photos, err := s.photosByStation(ctx, sta)
	if err != nil || len(photos) == 0 {
		s.serveFallbackCard(w, r)
		return
	}

	// Apply the viewer's clamps before selecting/rendering so the card frames
	// exactly what the on-screen camera would.
	az := degToRad(azDeg)
	alt := clampF(degToRad(altDeg), -ogPitchLimit, ogPitchLimit)
	fov := degToRad(clampF(fovDeg, ogFovMinDeg, ogFovMaxDeg))

	photo, ok := selectCoveringPhoto(photos, az, alt)
	if !ok || photo.BlobPath == nil {
		s.serveFallbackCard(w, r)
		return
	}

	key := ogCacheKey(sta, azDeg, altDeg, fovDeg, *photo.BlobPath)

	f, err := s.blobs.openOgByHash(ctx, key)
	if err != nil {
		buf, status := s.renderOgCard(ctx, photo, az, alt, fov)
		if status != "" {
			s.serveFallbackCard(w, r)
			return
		}
		if err := s.blobs.writeOg(ctx, key, bytes.NewReader(buf)); err != nil {
			// Cache write failed; still serve the freshly-rendered bytes.
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			_, _ = w.Write(buf)
			return
		}
		f, err = s.blobs.openOgByHash(ctx, key)
		if err != nil {
			s.serveFallbackCard(w, r)
			return
		}
	}
	defer f.Close()
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeContent(w, r, "", f.ModTime(), f)
}

func (s *Server) serveFallbackCard(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, fallbackCard, http.StatusFound)
}

func ogCacheKey(sta string, azDeg, altDeg, fovDeg float64, blobPath string) string {
	raw := fmt.Sprintf("%s|%.3f|%.3f|%.3f|%s|%s",
		sta, azDeg, altDeg, fovDeg, filepath.Base(blobPath), ogCacheVer)
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// photoBasis is a photo plane's world placement, mirroring placeAt /
// Object3D.lookAt(0,0,0) + rotateZ(roll) in overlay-photos.ts.
type photoBasis struct {
	dir    vec3 // unit, origin → plane center (= plane normal facing origin)
	center vec3 // plane center at overlayR·dir
	xAxis  vec3 // plane local +X (image right) in world
	yAxis  vec3 // plane local +Y (image up) in world
	w, h   float64
}

func buildPhotoBasis(p Photo) photoBasis {
	dir := dirFromAzAlt(p.PhotoAz, p.PhotoTilt).norm()
	center := dir.scale(overlayR)
	// Object3D.lookAt for a non-camera swaps eye/target: eye=origin,
	// target=center. z = (eye - target).norm() = -dir; x = up×z; y = z×x.
	z := dir.scale(-1)
	x := vec3{0, 1, 0}.cross(z).norm()
	y := z.cross(x)
	// rotateZ(roll): rotate the local X/Y basis about the plane normal.
	if p.PhotoRoll != 0 {
		c, sn := math.Cos(p.PhotoRoll), math.Sin(p.PhotoRoll)
		x, y = x.scale(c).add(y.scale(sn)), x.scale(-sn).add(y.scale(c))
	}
	w := 2 * overlayR * math.Tan(p.SizeRad/2)
	return photoBasis{dir: dir, center: center, xAxis: x, yAxis: y, w: w, h: w / p.Aspect}
}

// planeUV intersects the ray origin→d with the photo plane and returns the
// plane-local uv in [0,1]² (false if behind the camera or outside the plane).
func (b photoBasis) planeUV(d vec3) (u, v float64, ok bool) {
	denom := d.dot(b.dir)
	if denom <= 0 {
		return 0, 0, false
	}
	hit := d.scale(overlayR / denom)
	rel := hit.sub(b.center)
	u = rel.dot(b.xAxis)/b.w + 0.5
	v = rel.dot(b.yAxis)/b.h + 0.5
	return u, v, u >= 0 && u <= 1 && v >= 0 && v <= 1
}

// selectCoveringPhoto picks the photo whose plane the center ray (az,alt)
// hits in-bounds, tie-broken by smallest angular distance to the photo's
// pointing direction (first match wins on an exact tie).
func selectCoveringPhoto(photos []Photo, az, alt float64) (Photo, bool) {
	center := dirFromAzAlt(az, alt)
	var best Photo
	var bestAng = math.Inf(1)
	found := false
	for _, p := range photos {
		if p.BlobPath == nil {
			continue
		}
		b := buildPhotoBasis(p)
		if _, _, ok := b.planeUV(center); !ok {
			continue
		}
		ang := math.Acos(clampF(center.dot(b.dir), -1, 1))
		if !found || ang < bestAng-1e-9 {
			best, bestAng, found = p, ang, true
		}
	}
	return best, found
}

// renderOgCard reprojects the photo into a 1200x630 view centered on (az,alt)
// with vertical fov. Returns ("") on success or a non-empty reason on failure.
func (s *Server) renderOgCard(ctx context.Context, p Photo, az, alt, fov float64) ([]byte, string) {
	src, status := s.decodePhoto(ctx, p)
	if status != "" {
		return nil, status
	}
	srcB := src.Bounds()
	srcW, srcH := srcB.Dx(), srcB.Dy()

	basis := buildPhotoBasis(p)
	camF := dirFromAzAlt(az, alt)
	camX := rotYX(az, alt, vec3{1, 0, 0})
	camY := rotYX(az, alt, vec3{0, 1, 0})
	tanV := math.Tan(fov / 2)
	tanH := tanV * float64(ogCardW) / float64(ogCardH)

	// Distortion is in tan-space, matching the shader (overlay-photos.ts).
	distW := 2 * math.Tan(p.SizeRad/2)
	k1, k2 := p.DistK1, p.DistK2

	dst := image.NewRGBA(image.Rect(0, 0, ogCardW, ogCardH))
	bg := []uint8{20, 20, 20, 255}
	for py := 0; py < ogCardH; py++ {
		ndcY := 1 - 2*(float64(py)+0.5)/float64(ogCardH)
		for px := 0; px < ogCardW; px++ {
			ndcX := 2*(float64(px)+0.5)/float64(ogCardW) - 1
			d := camF.add(camX.scale(ndcX * tanH)).add(camY.scale(ndcY * tanV)).norm()
			off := (py*ogCardW + px) * 4
			u, v, ok := basis.planeUV(d)
			if !ok {
				copy(dst.Pix[off:off+4], bg)
				continue
			}
			// Forward Brown-Conrady on the sample coord (shader path).
			cx, cy := u-0.5, v-0.5
			xx, yy := cx*distW, cy*distW/p.Aspect
			r2 := xx*xx + yy*yy
			fdist := 1 + k1*r2 + k2*r2*r2
			su, sv := cx*fdist+0.5, cy*fdist+0.5
			if su < 0 || su > 1 || sv < 0 || sv > 1 {
				copy(dst.Pix[off:off+4], bg)
				continue
			}
			// Texture v is bottom-up (flipY); image rows are top-down.
			fx := su * float64(srcW-1)
			fy := (1 - sv) * float64(srcH-1)
			r, g, b := sampleBilinear(src, fx, fy)
			dst.Pix[off+0] = r
			dst.Pix[off+1] = g
			dst.Pix[off+2] = b
			dst.Pix[off+3] = 255
		}
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: ogJPEGQ}); err != nil {
		return nil, "encode"
	}
	return buf.Bytes(), ""
}

// decodePhoto opens the photo's blob, rejects oversized images, and decodes
// into an *image.RGBA for fast indexed sampling.
func (s *Server) decodePhoto(ctx context.Context, p Photo) (*image.RGBA, string) {
	f, err := s.blobs.openByPath(ctx, *p.BlobPath)
	if err != nil {
		return nil, "blob missing"
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return nil, "decode config"
	}
	if int64(cfg.Width)*int64(cfg.Height) > s.maxImagePixels {
		return nil, "image too large"
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, "seek"
	}
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, "decode"
	}
	if rgba, ok := img.(*image.RGBA); ok {
		return rgba, ""
	}
	rgba := image.NewRGBA(img.Bounds())
	draw.Draw(rgba, rgba.Bounds(), img, img.Bounds().Min, draw.Src)
	return rgba, ""
}

// sampleBilinear bilinearly samples src at fractional (fx, fy) in pixel space.
func sampleBilinear(src *image.RGBA, fx, fy float64) (uint8, uint8, uint8) {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	x0 := int(math.Floor(fx))
	y0 := int(math.Floor(fy))
	tx := fx - float64(x0)
	ty := fy - float64(y0)
	x0 = clampInt(x0, 0, w-1)
	y0 = clampInt(y0, 0, h-1)
	x1 := clampInt(x0+1, 0, w-1)
	y1 := clampInt(y0+1, 0, h-1)
	r00, g00, b00 := pixAt(src, x0, y0)
	r10, g10, b10 := pixAt(src, x1, y0)
	r01, g01, b01 := pixAt(src, x0, y1)
	r11, g11, b11 := pixAt(src, x1, y1)
	lerp := func(a, b, t float64) float64 { return a + (b-a)*t }
	mix := func(c00, c10, c01, c11 float64) uint8 {
		top := lerp(c00, c10, tx)
		bot := lerp(c01, c11, tx)
		return uint8(clampF(lerp(top, bot, ty)+0.5, 0, 255))
	}
	return mix(float64(r00), float64(r10), float64(r01), float64(r11)),
		mix(float64(g00), float64(g10), float64(g01), float64(g11)),
		mix(float64(b00), float64(b10), float64(b01), float64(b11))
}

func pixAt(src *image.RGBA, x, y int) (uint8, uint8, uint8) {
	o := src.PixOffset(x, y)
	return src.Pix[o], src.Pix[o+1], src.Pix[o+2]
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
