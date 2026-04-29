// DEM-driven terrain reference for the 360° viewer.
//
// Fetches AWS Open Data Terrain Tiles (Terrarium PNG encoding) around a camera
// location, decodes elevations, builds Three.js meshes in real-world meters
// centered on the camera, and renders them in one of three modes:
//   - 'off'       — no meshes
//   - 'wireframe' — translucent blue wireframe (alignment ghost)
//   - 'shaded'    — opaque surface lit by a directional sun
//
// Coverage is layered as concentric rings of progressively coarser zoom so
// distant features (e.g. peaks 100+ km away) appear without paying full
// inner-ring resolution everywhere. Ring sizing is driven by a target angular
// pitch per vertex — see TARGET_PITCH_RAD and the RINGS table.
//
// Tile source: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
// Encoding:    elevation_meters = R * 256 + G + B / 256 - 32768

import * as THREE from 'three';
import type { LatLng } from './types.js';
import {
  TILE_PX,
  fetchTileElevations,
  latToTileY,
  lngToTileX,
  tileKey,
  tileXToLng,
  tileYToLat,
} from './dem.js';
import { sunDirection } from './solar.js';

// Outer-edge angular-pitch target driving the ring layout below: ~5 mrad
// (~0.29°). At 75° FOV / ~1920 px viewport one screen pixel subtends ~0.7
// mrad, so 5 mrad ≈ 7 px per mesh cell — coarser than per-pixel but enough
// for a reference surface. To retune, pick a new target and re-derive RINGS.
interface RingSpec {
  zoom: number;
  radiusTiles: number;
  stride: number;
}

// Each successive ring drops 2 zoom levels (4× spacing, 4× tile width). The
// rebuild orchestrator threads each ring's outer half-width to the next so
// outer rings carve a hole exactly matching the inner ring's coverage —
// otherwise their meshes z-fight in the overlap band.
const RINGS: readonly RingSpec[] = [
  { zoom: 11, radiusTiles: 2, stride: 2 },
  { zoom:  9, radiusTiles: 2, stride: 2 },
  { zoom:  7, radiusTiles: 2, stride: 2 },
];

// World-meter coverage rectangle of a ring relative to the camera. Asymmetric
// because the camera generally isn't centered within its tile.
interface RingBounds {
  readonly xMin: number;
  readonly xMax: number;
  readonly zMin: number;
  readonly zMax: number;
}

const WIREFRAME_COLOR = 0x88aaff;
const WIREFRAME_OPACITY = 0.35;
// Per-vertex shaded coloring: water at/below sea level (DEM elevation ≤ 0),
// land everywhere else. Rough by design — inland lakes that sit above 0 m
// fall into the land bucket; that's fine for a reference layer.
const WATER_COLOR: readonly [number, number, number] = [0x40, 0x80, 0xa0];
const LAND_COLOR: readonly [number, number, number] = [0xb0, 0xa8, 0x90];
const DIR_LIGHT_INTENSITY = 1.4;
const AMBIENT_LIGHT_INTENSITY = 0.35;
// Far enough that direction is the only thing that matters; lambert ignores
// magnitude but Three.js still uses the position vector to build the direction.
const DIR_LIGHT_DISTANCE = 1000;

// Local-tangent-plane approximation: meters per degree latitude is roughly
// constant (Earth is round); per-degree longitude scales by cos(lat).
const M_PER_DEG_LAT = 111320;

export type TerrainMode = 'off' | 'wireframe' | 'shaded';

// Sample elevation at fractional pixel coords within a tile (nearest-neighbor).
function sampleTile(elev: Float32Array, px: number, py: number): number {
  const ix = Math.max(0, Math.min(TILE_PX - 1, Math.floor(px)));
  const iy = Math.max(0, Math.min(TILE_PX - 1, Math.floor(py)));
  return elev[iy * TILE_PX + ix]!;
}

export interface TerrainView {
  setLocation(camLoc: LatLng | null): void;
  setMode(mode: TerrainMode): void;
  getMode(): TerrainMode;
  setBakeVisible(visible: boolean): void;
  // Sun direction for the 'shaded' mode. Azimuth is radians from north
  // clockwise; altitude is radians above the horizon. Negative altitudes are
  // accepted (sun below horizon → terrain falls into ambient-only).
  setSunDirection(az: number, alt: number): void;
  // Camera height above local ground in meters. Implemented as a y-offset on
  // every ring mesh — the panorama camera stays at the scene origin so photo
  // overlays continue to wrap correctly around it.
  // Returns true if the value actually changed; lets callers skip downstream
  // refresh/save work when wheel events repeat the same height.
  setCameraHeight(meters: number): boolean;
  getCameraHeight(): number;
}

export interface CreateTerrainViewOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

// `ringIndex` 0 is the innermost ring; outer rings get a polygon-offset bias
// so they lose the depth test against any inner ring drawn at the same world
// position. The skip rule lets outer rings extend one quad into the inner
// ring's coverage to avoid gaps, and this offset prevents z-fighting in that
// overlap band.
function makeMaterial(mode: Exclude<TerrainMode, 'off'>, ringIndex: number): THREE.Material {
  const polygonOffset = ringIndex > 0;
  const polygonOffsetFactor = ringIndex;
  const polygonOffsetUnits = ringIndex;
  if (mode === 'wireframe') {
    return new THREE.MeshBasicMaterial({
      color: WIREFRAME_COLOR,
      wireframe: true,
      transparent: true,
      opacity: WIREFRAME_OPACITY,
      depthWrite: false,
      polygonOffset,
      polygonOffsetFactor,
      polygonOffsetUnits,
    });
  }
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset,
    polygonOffsetFactor,
    polygonOffsetUnits,
  });
}

interface RingResult {
  geometry: THREE.BufferGeometry;
  camGroundElev: number;
  bounds: RingBounds;
}

// Build one ring's geometry. When `prev` is supplied (every ring except the
// innermost), the ring reuses the inner ring's ground elevation so meshes line
// up at boundaries, and skips quads whose bounding box is fully contained in
// the inner ring's coverage rectangle. The "fully contained" rule lets outer
// quads extend one cell into the inner ring's coverage — that overlap gets
// resolved by per-ring polygonOffset (see makeMaterial) so the inner ring
// always wins the depth test there, no gap, no z-fighting.
async function buildRing(
  camLoc: LatLng,
  spec: RingSpec,
  prev?: { camGroundElev: number; bounds: RingBounds },
): Promise<RingResult> {
  const { zoom, radiusTiles, stride } = spec;

  const cxFrac = lngToTileX(camLoc.lng, zoom);
  const cyFrac = latToTileY(camLoc.lat, zoom);
  const cx = Math.floor(cxFrac);
  const cy = Math.floor(cyFrac);

  // Fetch the (2R+1)×(2R+1) window in parallel.
  const tilePromises: Promise<{ tx: number; ty: number; data: Float32Array | null }>[] = [];
  for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
    for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
      const tx = cx + dx;
      const ty = cy + dy;
      tilePromises.push(fetchTileElevations(zoom, tx, ty).then(data => ({ tx, ty, data })));
    }
  }
  const tiles = await Promise.all(tilePromises);

  const tileMap = new Map<string, Float32Array>();
  for (const t of tiles) {
    if (t.data) tileMap.set(tileKey(zoom, t.tx, t.ty), t.data);
  }

  const centerTile = tileMap.get(tileKey(zoom, cx, cy));
  const camGroundElev = prev?.camGroundElev ?? (centerTile
    ? sampleTile(centerTile, (cxFrac - cx) * TILE_PX, (cyFrac - cy) * TILE_PX)
    : 0);

  // Build the mesh: one vertex per (sampled) DEM pixel across the tile window,
  // with seams welded by including the rightmost/topmost edge.
  const samplesPerTile = TILE_PX / stride;
  const nx = samplesPerTile * (radiusTiles * 2 + 1) + 1;
  const ny = samplesPerTile * (radiusTiles * 2 + 1) + 1;

  const positions = new Float32Array(nx * ny * 3);
  const colors = new Uint8Array(nx * ny * 3);
  const cosLat = Math.cos(camLoc.lat * Math.PI / 180);

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
      const tile = tileMap.get(tileKey(zoom, tx, ty));
      const elev = tile ? tile[py * TILE_PX + px]! : 0;
      const idx = (j * nx + i) * 3;
      positions[idx] = colWx[i]!;
      positions[idx + 1] = elev - camGroundElev;
      positions[idx + 2] = wz;
      const c = elev <= 0 ? WATER_COLOR : LAND_COLOR;
      colors[idx]     = c[0];
      colors[idx + 1] = c[1];
      colors[idx + 2] = c[2];
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
  const indices = new Uint32Array(quadCount * 6);
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
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  // slice() (not subarray) so the over-allocation isn't retained via the view.
  geometry.setIndex(new THREE.BufferAttribute(indices.slice(0, k), 1));
  // Normals required for Lambert lighting; cheap enough to always compute so
  // wireframe→shaded swaps don't need a rebuild.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const bounds: RingBounds = {
    xMin: colWx[0]!,
    xMax: colWx[nx - 1]!,
    zMin: Math.min(rowWz[0]!, rowWz[ny - 1]!),
    zMax: Math.max(rowWz[0]!, rowWz[ny - 1]!),
  };
  return { geometry, camGroundElev, bounds };
}

export function createTerrainView({ scene, requestRender }: CreateTerrainViewOptions): TerrainView {
  let mode: TerrainMode = 'off';
  let bakeHidden = false;
  let location: LatLng | null = null;
  let meshes: THREE.Mesh[] = [];
  let buildId = 0;
  let cameraHeight = 0;
  let sunAz = Math.PI;       // default: due south
  let sunAlt = Math.PI / 4;  // default: 45° up

  // Lights are added on first transition out of 'off' and stay in the scene
  // afterwards. MeshBasicMaterial (wireframe + photo overlays) ignores lights,
  // so leaving them on permanently is harmless.
  let dirLight: THREE.DirectionalLight | null = null;
  let ambientLight: THREE.AmbientLight | null = null;

  function ensureLights(): void {
    if (dirLight) return;
    dirLight = new THREE.DirectionalLight(0xffffff, DIR_LIGHT_INTENSITY);
    ambientLight = new THREE.AmbientLight(0xffffff, AMBIENT_LIGHT_INTENSITY);
    scene.add(dirLight);
    scene.add(ambientLight);
    applySunDirection();
  }

  function applySunDirection(): void {
    if (!dirLight) return;
    const d = sunDirection(sunAz, sunAlt);
    dirLight.position.set(d.x * DIR_LIGHT_DISTANCE, d.y * DIR_LIGHT_DISTANCE, d.z * DIR_LIGHT_DISTANCE);
    // Below-horizon: kill direct light so only ambient remains. Otherwise the
    // sun illuminates the underside of terrain, which looks like moonlight.
    dirLight.intensity = sunAlt > 0 ? DIR_LIGHT_INTENSITY : 0;
  }

  function applyCameraHeight(): void {
    for (const m of meshes) m.position.y = -cameraHeight;
  }

  function disposeMeshes(): void {
    for (const m of meshes) {
      scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    meshes = [];
  }

  function applyVisibility(): void {
    const visible = mode !== 'off' && !bakeHidden;
    for (const m of meshes) m.visible = visible;
  }

  // Swap each mesh's material in place — used when toggling between wireframe
  // and shaded without regenerating the (expensive) geometry.
  function swapMaterials(toMode: Exclude<TerrainMode, 'off'>): void {
    meshes.forEach((m, ringIndex) => {
      const old = m.material as THREE.Material;
      m.material = makeMaterial(toMode, ringIndex);
      old.dispose();
    });
  }

  async function rebuild(camLoc: LatLng, buildMode: Exclude<TerrainMode, 'off'>): Promise<void> {
    const myBuildId = ++buildId;

    // Kick off every ring's tile fetches before awaiting any: dem.ts dedupes
    // via its inflight map, so this just warms the cache so the outer rings'
    // network round-trips overlap with the inner ring's geometry build instead
    // of running serially after it.
    for (const spec of RINGS) {
      const cx = Math.floor(lngToTileX(camLoc.lng, spec.zoom));
      const cy = Math.floor(latToTileY(camLoc.lat, spec.zoom));
      for (let dy = -spec.radiusTiles; dy <= spec.radiusTiles; dy++) {
        for (let dx = -spec.radiusTiles; dx <= spec.radiusTiles; dx++) {
          void fetchTileElevations(spec.zoom, cx + dx, cy + dy);
        }
      }
    }

    // Build inner ring first to fix camGroundElev; outer rings reuse it so the
    // meshes line up cleanly at boundaries. Each ring's outer coverage is
    // passed to the next so it can carve a matching hole and avoid z-fighting.
    const built: THREE.BufferGeometry[] = [];
    let prev: { camGroundElev: number; bounds: RingBounds } | undefined;
    for (const spec of RINGS) {
      const result = await buildRing(camLoc, spec, prev);
      if (myBuildId !== buildId) {
        for (const g of built) g.dispose();
        result.geometry.dispose();
        return;
      }
      prev = { camGroundElev: result.camGroundElev, bounds: result.bounds };
      built.push(result.geometry);
    }

    disposeMeshes();
    built.forEach((geometry, ringIndex) => {
      const mesh = new THREE.Mesh(geometry, makeMaterial(buildMode, ringIndex));
      mesh.frustumCulled = false; // bounding sphere is huge; we always want it on screen
      // Always draw before photo overlays (which use depthTest:false to stay on
      // top regardless of whether they physically intersect terrain).
      mesh.renderOrder = -1;
      scene.add(mesh);
      meshes.push(mesh);
    });
    applyVisibility();
    applyCameraHeight();
    requestRender();
  }

  function maybeRebuild(): void {
    if (mode === 'off' || !location) {
      disposeMeshes();
      requestRender();
      return;
    }
    void rebuild(location, mode);
  }

  return {
    setLocation(camLoc) {
      location = camLoc;
      maybeRebuild();
    },
    setMode(value) {
      if (mode === value) return;
      const prev = mode;
      mode = value;
      if (value !== 'off') ensureLights();
      // Wireframe↔shaded with live meshes: just swap materials, keep geometry.
      // Anything involving 'off' (or starting from no meshes) goes through rebuild.
      if (meshes.length > 0 && prev !== 'off' && value !== 'off') {
        swapMaterials(value);
        applyVisibility();
        requestRender();
      } else {
        maybeRebuild();
      }
    },
    getMode: () => mode,
    setBakeVisible(visible) {
      bakeHidden = !visible;
      applyVisibility();
    },
    setSunDirection(az, alt) {
      if (sunAz === az && sunAlt === alt) return;
      sunAz = az;
      sunAlt = alt;
      applySunDirection();
      if (mode === 'shaded') requestRender();
    },
    setCameraHeight(meters) {
      if (cameraHeight === meters) return false;
      cameraHeight = meters;
      applyCameraHeight();
      requestRender();
      return true;
    },
    getCameraHeight: () => cameraHeight,
  };
}
