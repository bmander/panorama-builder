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
  // When true, the central tile of this ring is omitted from the index buffer
  // (a 1×1 hole). Inner rings already cover that area at higher resolution; the
  // hole prevents z-fighting and saves indices.
  skipCentralTile: boolean;
}

// Each successive ring drops 2 zoom levels (4× spacing, 4× tile width). With
// RADIUS_TILES=2 + central-tile skip, ring N's outer half-distance equals
// ring N+1's inner half-distance (2.5 × tile_N = 0.5 × tile_{N+1}).
const RINGS: readonly RingSpec[] = [
  { zoom: 11, radiusTiles: 2, stride: 2, skipCentralTile: false },
  { zoom:  9, radiusTiles: 2, stride: 2, skipCentralTile: true  },
  { zoom:  7, radiusTiles: 2, stride: 2, skipCentralTile: true  },
];

const WIREFRAME_COLOR = 0x88aaff;
const WIREFRAME_OPACITY = 0.35;
const SHADED_COLOR = 0xb0a890;
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

function makeMaterial(mode: Exclude<TerrainMode, 'off'>): THREE.Material {
  if (mode === 'wireframe') {
    return new THREE.MeshBasicMaterial({
      color: WIREFRAME_COLOR,
      wireframe: true,
      transparent: true,
      opacity: WIREFRAME_OPACITY,
      depthWrite: false,
    });
  }
  return new THREE.MeshLambertMaterial({
    color: SHADED_COLOR,
    side: THREE.DoubleSide,
  });
}

// Build one ring's geometry. `sharedGroundElev`, when supplied, forces the
// ring to use a shared ground reference (so adjacent rings line up at the
// boundary); otherwise the ring samples its own central tile. Returns both the
// geometry and the ground elevation it used so the caller can plumb it onward.
async function buildRing(
  camLoc: LatLng,
  spec: RingSpec,
  sharedGroundElev?: number,
): Promise<{ geometry: THREE.BufferGeometry; camGroundElev: number }> {
  const { zoom, radiusTiles, stride, skipCentralTile } = spec;

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
  const camGroundElev = sharedGroundElev ?? (centerTile
    ? sampleTile(centerTile, (cxFrac - cx) * TILE_PX, (cyFrac - cy) * TILE_PX)
    : 0);

  // Build the mesh: one vertex per (sampled) DEM pixel across the tile window,
  // with seams welded by including the rightmost/topmost edge.
  const samplesPerTile = TILE_PX / stride;
  const nx = samplesPerTile * (radiusTiles * 2 + 1) + 1;
  const ny = samplesPerTile * (radiusTiles * 2 + 1) + 1;

  const positions = new Float32Array(nx * ny * 3);
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
    }
  }

  // Triangle indices. (nx-1)*(ny-1) quads, two triangles each. When skipping
  // the central tile, omit quads whose i,j fall in the central tile's vertex
  // range so the inner ring fills that area without z-fighting.
  const skipMin = samplesPerTile * radiusTiles;
  const skipMax = samplesPerTile * (radiusTiles + 1);
  const quadCount = (nx - 1) * (ny - 1);
  // Use Uint32Array since vertex count can exceed 65535. Slight over-allocation
  // when skipping; trimmed via setIndex(BufferAttribute) on the actual k value.
  const indices = new Uint32Array(quadCount * 6);
  let k = 0;
  for (let j = 0; j < ny - 1; j++) {
    const inSkipJ = j >= skipMin && j < skipMax;
    for (let i = 0; i < nx - 1; i++) {
      if (skipCentralTile && inSkipJ && i >= skipMin && i < skipMax) continue;
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
  // Slice down to the quads we actually emitted (relevant when skipping).
  geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, k), 1));
  // Normals required for Lambert lighting; cheap enough to always compute so
  // wireframe→shaded swaps don't need a rebuild.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return { geometry, camGroundElev };
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
    for (const m of meshes) {
      const old = m.material as THREE.Material;
      m.material = makeMaterial(toMode);
      old.dispose();
    }
  }

  async function rebuild(camLoc: LatLng, buildMode: Exclude<TerrainMode, 'off'>): Promise<void> {
    const myBuildId = ++buildId;

    // Build inner ring first to fix camGroundElev; outer rings reuse it so the
    // meshes line up cleanly at boundaries despite their differing zoom levels.
    const built: THREE.BufferGeometry[] = [];
    let sharedGroundElev: number | undefined;
    for (const spec of RINGS) {
      const result = await buildRing(camLoc, spec, sharedGroundElev);
      if (myBuildId !== buildId) {
        for (const g of built) g.dispose();
        result.geometry.dispose();
        return;
      }
      sharedGroundElev = result.camGroundElev;
      built.push(result.geometry);
    }

    disposeMeshes();
    for (const geometry of built) {
      const mesh = new THREE.Mesh(geometry, makeMaterial(buildMode));
      mesh.frustumCulled = false; // bounding sphere is huge; we always want it on screen
      // Always draw before photo overlays (which use depthTest:false to stay on
      // top regardless of whether they physically intersect terrain).
      mesh.renderOrder = -1;
      scene.add(mesh);
      meshes.push(mesh);
    }
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
