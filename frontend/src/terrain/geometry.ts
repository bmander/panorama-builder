import {
  TILE_PX,
  latToTileY,
  lngToTileX,
  tileKey,
  tileXToLng,
  tileYToLat,
} from '../dem.js';
import { M_PER_DEG_LAT, R_EARTH } from '../geo.js';
import { clamp, degToRad } from '../mathx.js';
import type { LatLng } from '../types.js';

// Ring layout is derived from a single target angular resolution. A pixel of
// size R subtends ≤ θ at distance ≥ R/θ. At zoom z, tile width T = 40_075_000
// · cos(lat) / 2^z meters and pixel size = T/256, so the cutoff distance —
// where pixel angular size hits θ — is (T/256)/θ = T / (256·θ). With θ = 5
// arcmin (≈1.4544 mrad), that's T · 2.687: the cutoff is always ~2.687 tile
// widths from the camera, regardless of zoom or latitude. So a single
// radiusTiles works at every level.
//
// Adjacent rings descend by exactly one zoom step (2× tile width). That
// matters geometrically: the inner ring's outer edge in the outer ring's
// tile coords lands at outer_cx + δ ± radiusTiles, where δ ∈ {0, 0.5} is
// the inner ring's tile-center offset relative to the outer's. With a 1/128
// vertex grid (stride = 2), 1/2 is a multiple of the grid spacing, so the
// inner edge falls exactly on outer-ring vertex columns. Every outer-ring
// quad is then either fully inside or fully outside the inner ring's
// rectangle — no straddle, no overlap, no z-fighting. Strict integer
// grid-index comparisons in buildRingGeometry's skip rule keep the cut
// exact even under floating-point drift.
export interface RingSpec {
  zoom: number;
  radiusTiles: number;
  stride: number;
}

// Outermost zoom: at lat 45° tile width ≈ 110 km, ring outer reach ≈ 275 km
// (close to the requested ~300 km cap; high-latitude camps land smaller).
// Innermost zoom: Terrarium serves up to z=14 (~7 m/px at 45°N) reliably;
// z=15 sometimes 404s.
const OUTER_ZOOM = 8;
const INNER_ZOOM = 14;

// 5×5 tile grid per ring. With stride = 2 that's a 641×641 vertex grid; the
// outer extent (2.5 tile widths on average) brackets the angular-resolution
// cutoff (~2.687 tile widths), and the inner-edge-on-grid-line invariant
// only holds for radiusTiles whose halving stays a multiple of 1/128 — which
// integer values do.
const RING_RADIUS_TILES = 2;
const RING_STRIDE = 2;

// Innermost ring first (zoom descending) so each outer ring sees its inner
// neighbor's coverage first and can carve a matching hole.
export function computeRings(): readonly RingSpec[] {
  const out: RingSpec[] = [];
  for (let z = INNER_ZOOM; z >= OUTER_ZOOM; z--) {
    out.push({ zoom: z, radiusTiles: RING_RADIUS_TILES, stride: RING_STRIDE });
  }
  return out;
}

// Curvature + standard atmospheric refraction. The geometric drop below the
// tangent plane at distance d from the camera is d²/(2R) (small-angle
// approximation; correct to <0.2 % at 525 km). Light refracts back toward
// Earth, raising apparent positions by k·d²/(2R); the surveyor's k = 0.14
// (the "0.0675 d² km" rule of thumb) cancels part of the drop. Net y-offset:
// −(1 − k) · d² / (2R), which reaches 73 m at 33 km, 608 m at 95 km, and
// ~25 km at the outermost ring's horizon.
const SURVEY_REFRACTION_K = 0.14;
// drop = factor · d². Curvature off → 0 (flat plane). Curvature on,
// refraction off → full geometric drop. Both on → drop reduced by k.
export const CURVATURE_FACTOR_GEOMETRIC = 1 / (2 * R_EARTH);
export const CURVATURE_FACTOR_REFRACTED = (1 - SURVEY_REFRACTION_K) / (2 * R_EARTH);

// Outer-edge rectangle of a ring in its own zoom's tile-fractional coords.
// The next-coarser ring uses this to carve a matching hole, halving each
// coordinate (one zoom step ⇒ tile width × 2) to map onto its grid.
export interface RingHole {
  innerTileXMin: number;
  innerTileXMax: number;
  innerTileYMin: number;
  innerTileYMax: number;
}

export interface RingGeometry {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

// Cheap, tile-data-free derivation: a ring's outer extent depends only on
// the camera's lat/lng and its (zoom, radiusTiles) spec. Lets the rebuild
// orchestrator pre-compute every ring's hole before any tile arrives.
export function ringBounds(camLoc: LatLng, spec: RingSpec): RingHole {
  const cx = Math.floor(lngToTileX(camLoc.lng, spec.zoom));
  const cy = Math.floor(latToTileY(camLoc.lat, spec.zoom));
  return {
    innerTileXMin: cx - spec.radiusTiles,
    innerTileXMax: cx + spec.radiusTiles + 1,
    innerTileYMin: cy - spec.radiusTiles,
    innerTileYMax: cy + spec.radiusTiles + 1,
  };
}

// Sample elevation at fractional pixel coords within a tile (nearest-neighbor).
export function sampleTile(elev: Float32Array, px: number, py: number): number {
  const ix = clamp(Math.floor(px), 0, TILE_PX - 1);
  const iy = clamp(Math.floor(py), 0, TILE_PX - 1);
  return elev[iy * TILE_PX + ix]!;
}

// Build one ring's geometry. `camGroundElev` is the y-reference shared
// across all rings (sampled once at rebuild start so rings line up
// vertically). `hole`, if supplied, is the next-finer ring's outer
// rectangle; the build skips quads whose four corners all sit inside it.
// With the consecutive-zoom schedule the hole's edges land exactly on this
// ring's vertex grid, so every quad is fully inside or fully outside —
// a true clean cut: no overlap, no z-fighting at the seam.
export function buildRingGeometry(
  camLoc: LatLng,
  spec: RingSpec,
  curvatureFactor: number,
  demTiles: ReadonlyMap<string, Float32Array>,
  camGroundElev: number,
  hole?: RingHole,
): RingGeometry {
  const { zoom, radiusTiles, stride } = spec;

  const cxFrac = lngToTileX(camLoc.lng, zoom);
  const cyFrac = latToTileY(camLoc.lat, zoom);
  const cx = Math.floor(cxFrac);
  const cy = Math.floor(cyFrac);

  // Build the mesh: one vertex per (sampled) DEM pixel across the tile window,
  // with seams welded by including the rightmost/topmost edge.
  const samplesPerTile = TILE_PX / stride;
  const nx = samplesPerTile * (radiusTiles * 2 + 1) + 1;
  const ny = samplesPerTile * (radiusTiles * 2 + 1) + 1;

  const positions = new Float32Array(nx * ny * 3);
  const uvs = new Float32Array(nx * ny * 2);
  const cosLat = Math.cos(degToRad(camLoc.lat));

  // Precompute per-row and per-column geometry once. Each row's tile + sub-pixel
  // depends only on j; each column's depends only on i; and the world-meters
  // wx / wz follow from those. Pulls 410k function calls out of the inner loop.
  const rowTy = new Int32Array(ny);
  const rowPy = new Int32Array(ny);
  const rowWz = new Float64Array(ny);
  for (let j = 0; j < ny; j++) {
    const tileJ = Math.floor(j / samplesPerTile);
    const subJ = j - tileJ * samplesPerTile;
    const ty = cy - radiusTiles + tileJ;
    const py = (subJ === samplesPerTile) ? TILE_PX - 1 : subJ * stride;
    const lat = tileYToLat(ty + py / TILE_PX, zoom);
    rowTy[j] = ty;
    rowPy[j] = py;
    rowWz[j] = -(lat - camLoc.lat) * M_PER_DEG_LAT;
  }
  const colTx = new Int32Array(nx);
  const colPx = new Int32Array(nx);
  const colWx = new Float64Array(nx);
  for (let i = 0; i < nx; i++) {
    const tileI = Math.floor(i / samplesPerTile);
    const subI = i - tileI * samplesPerTile;
    const tx = cx - radiusTiles + tileI;
    const px = (subI === samplesPerTile) ? TILE_PX - 1 : subI * stride;
    const lng = tileXToLng(tx + px / TILE_PX, zoom);
    colTx[i] = tx;
    colPx[i] = px;
    colWx[i] = (lng - camLoc.lng) * M_PER_DEG_LAT * cosLat;
  }

  for (let j = 0; j < ny; j++) {
    const ty = rowTy[j]!;
    const py = rowPy[j]!;
    const wz = rowWz[j]!;
    for (let i = 0; i < nx; i++) {
      const tx = colTx[i]!;
      const px = colPx[i]!;
      const tile = demTiles.get(tileKey(zoom, tx, ty));
      const elev = tile ? tile[py * TILE_PX + px]! : 0;
      const idx = (j * nx + i) * 3;
      const wx = colWx[i]!;
      const drop = curvatureFactor * (wx * wx + wz * wz);
      positions[idx] = wx;
      positions[idx + 1] = elev - camGroundElev - drop;
      positions[idx + 2] = wz;
      const uvIdx = (j * nx + i) * 2;
      uvs[uvIdx] = i / (nx - 1);
      uvs[uvIdx + 1] = j / (ny - 1);
    }
  }

  // Map the inner ring's outer rectangle into this ring's vertex grid as
  // integer index ranges. The divisor is 2 because computeRings emits
  // adjacent zoom levels; Math.round absorbs only float noise.
  let iHoleMin = 0, iHoleMax = 0, jHoleMin = 0, jHoleMax = 0;
  if (hole) {
    iHoleMin = Math.round((hole.innerTileXMin / 2 - (cx - radiusTiles)) * samplesPerTile);
    iHoleMax = Math.round((hole.innerTileXMax / 2 - (cx - radiusTiles)) * samplesPerTile);
    jHoleMin = Math.round((hole.innerTileYMin / 2 - (cy - radiusTiles)) * samplesPerTile);
    jHoleMax = Math.round((hole.innerTileYMax / 2 - (cy - radiusTiles)) * samplesPerTile);
  }

  // Skip quads with all four corners inside the inner-ring hole. Boundary
  // indices count as inside, so boundary-touching quads on the inner side
  // drop out and on the outer side stay.
  const quadCount = (nx - 1) * (ny - 1);
  // Uint32 indices: vertex count exceeds 65535.
  const indexBuf = new Uint32Array(quadCount * 6);
  let k = 0;
  for (let j = 0; j < ny - 1; j++) {
    const jInside = hole !== undefined && j >= jHoleMin && j + 1 <= jHoleMax;
    for (let i = 0; i < nx - 1; i++) {
      if (jInside && i >= iHoleMin && i + 1 <= iHoleMax) continue;
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indexBuf[k++] = a; indexBuf[k++] = c; indexBuf[k++] = b;
      indexBuf[k++] = b; indexBuf[k++] = c; indexBuf[k++] = d;
    }
  }
  // slice() (not subarray) so the over-allocation isn't retained via the view.
  const indices = indexBuf.slice(0, k);

  return { positions, uvs, indices };
}
