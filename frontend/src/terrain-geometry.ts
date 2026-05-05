import {
  TILE_PX,
  latToTileY,
  lngToTileX,
  tileKey,
  tileXToLng,
  tileYToLat,
} from './dem.js';
import { M_PER_DEG_LAT, R_EARTH } from './geo.js';
import { clamp, degToRad } from './mathx.js';
import type { LatLng } from './types.js';

// Outer-edge angular-pitch target driving the ring layout below: ~5 mrad
// (~0.29°). At 75° FOV / ~1920 px viewport one screen pixel subtends ~0.7
// mrad, so 5 mrad ≈ 7 px per mesh cell — coarser than per-pixel but enough
// for a reference surface. To retune, pick a new target and re-derive RINGS.
export interface RingSpec {
  zoom: number;
  radiusTiles: number;
  stride: number;
}

// Each successive ring drops 2 zoom levels (4× spacing, 4× tile width). The
// rebuild orchestrator threads each ring's outer half-width to the next so
// outer rings carve a hole exactly matching the inner ring's coverage —
// otherwise their meshes z-fight in the overlap band.
export const RINGS: readonly RingSpec[] = [
  { zoom: 11, radiusTiles: 2, stride: 2 },
  { zoom:  9, radiusTiles: 2, stride: 2 },
  { zoom:  7, radiusTiles: 2, stride: 2 },
];

// World-meter coverage rectangle of a ring relative to the camera. Asymmetric
// because the camera generally isn't centered within its tile.
export interface RingBounds {
  readonly xMin: number;
  readonly xMax: number;
  readonly zMin: number;
  readonly zMax: number;
}

// Curvature + standard atmospheric refraction. The geometric drop below the
// tangent plane at distance d from the camera is d²/(2R) (small-angle
// approximation; correct to <0.2 % at 525 km). Light refracts back toward
// Earth, raising apparent positions by k·d²/(2R); the surveyor's k = 0.14
// (the "0.0675 d² km" rule of thumb) cancels part of the drop. Net y-offset:
// −(1 − k) · d² / (2R), which reaches 73 m at 33 km, 608 m at 95 km, and
// 18.6 km at the outer ring's 525 km horizon.
const SURVEY_REFRACTION_K = 0.14;
// drop = factor · d². Curvature off → 0 (flat plane). Curvature on,
// refraction off → full geometric drop. Both on → drop reduced by k.
export const CURVATURE_FACTOR_GEOMETRIC = 1 / (2 * R_EARTH);
export const CURVATURE_FACTOR_REFRACTED = (1 - SURVEY_REFRACTION_K) / (2 * R_EARTH);

export interface PrevRing {
  camGroundElev: number;
  bounds: RingBounds;
}

export interface RingGeometry {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  camGroundElev: number;
  bounds: RingBounds;
}

// Sample elevation at fractional pixel coords within a tile (nearest-neighbor).
function sampleTile(elev: Float32Array, px: number, py: number): number {
  const ix = clamp(Math.floor(px), 0, TILE_PX - 1);
  const iy = clamp(Math.floor(py), 0, TILE_PX - 1);
  return elev[iy * TILE_PX + ix]!;
}

// Build one ring's geometry. When `prev` is supplied (every ring except the
// innermost), the ring reuses the inner ring's ground elevation so meshes line
// up at boundaries, and skips quads whose bounding box is fully contained in
// the inner ring's coverage rectangle. The "fully contained" rule lets outer
// quads extend one cell into the inner ring's coverage — that overlap gets
// resolved by per-ring polygonOffset (see makeMaterial in terrain.ts) so the
// inner ring always wins the depth test there, no gap, no z-fighting.
export function buildRingGeometry(
  camLoc: LatLng,
  spec: RingSpec,
  curvatureFactor: number,
  demTiles: ReadonlyMap<string, Float32Array>,
  prev?: PrevRing,
): RingGeometry {
  const { zoom, radiusTiles, stride } = spec;

  const cxFrac = lngToTileX(camLoc.lng, zoom);
  const cyFrac = latToTileY(camLoc.lat, zoom);
  const cx = Math.floor(cxFrac);
  const cy = Math.floor(cyFrac);

  const centerTile = demTiles.get(tileKey(zoom, cx, cy));
  const camGroundElev = prev?.camGroundElev ?? (centerTile
    ? sampleTile(centerTile, (cxFrac - cx) * TILE_PX, (cyFrac - cy) * TILE_PX)
    : 0);

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

  // Skip quads fully inside the inner ring's bounds. Quads that straddle the
  // boundary stay (one cell of overlap with the inner ring), which makes the
  // boundary seamless; polygonOffset on the outer ring's material biases its
  // depth so the inner ring wins the overlap.
  const ixMin = prev?.bounds.xMin ?? 0;
  const ixMax = prev?.bounds.xMax ?? 0;
  const izMin = prev?.bounds.zMin ?? 0;
  const izMax = prev?.bounds.zMax ?? 0;
  const quadCount = (nx - 1) * (ny - 1);
  // Uint32 since vertex count can exceed 65535. Over-allocated when skipping;
  // trimmed below via slice() so the unused tail is GC-eligible.
  const indexBuf = new Uint32Array(quadCount * 6);
  let k = 0;
  for (let j = 0; j < ny - 1; j++) {
    const wzA = rowWz[j]!, wzB = rowWz[j + 1]!;
    const zMin = Math.min(wzA, wzB);
    const zMax = Math.max(wzA, wzB);
    const zInside = zMin >= izMin && zMax <= izMax;
    for (let i = 0; i < nx - 1; i++) {
      if (prev && zInside) {
        const wxA = colWx[i]!, wxB = colWx[i + 1]!;
        if (Math.min(wxA, wxB) >= ixMin && Math.max(wxA, wxB) <= ixMax) continue;
      }
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

  const bounds: RingBounds = {
    xMin: colWx[0]!,
    xMax: colWx[nx - 1]!,
    zMin: Math.min(rowWz[0]!, rowWz[ny - 1]!),
    zMax: Math.max(rowWz[0]!, rowWz[ny - 1]!),
  };

  return { positions, uvs, indices, camGroundElev, bounds };
}
