// DEM-driven terrain reference for the 360° viewer.
//
// Fetches AWS Open Data Terrain Tiles (Terrarium PNG encoding) around a camera
// location, decodes elevations, builds a Three.js mesh in real-world meters
// centered on the camera, and renders it in one of three modes:
//   - 'off'       — no mesh
//   - 'wireframe' — translucent blue wireframe (alignment ghost)
//   - 'shaded'    — opaque surface lit by a directional sun
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

const ZOOM = 11;
const RADIUS_TILES = 2;             // 5×5 = (2*R+1)^2 tiles around centre
const SAMPLE_STRIDE = 2;             // every other DEM pixel → ~110 m spacing at zoom 11
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
  // Camera height above local ground in meters. Implemented as a mesh y-offset
  // (`mesh.position.y = -h`) — the panorama camera stays at the scene origin so
  // photo overlays continue to wrap correctly around it.
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

export function createTerrainView({ scene, requestRender }: CreateTerrainViewOptions): TerrainView {
  let mode: TerrainMode = 'off';
  let bakeHidden = false;
  let location: LatLng | null = null;
  let mesh: THREE.Mesh | null = null;
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
    if (mesh) mesh.position.y = -cameraHeight;
  }

  function disposeMesh(): void {
    if (!mesh) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    mesh = null;
  }

  function applyVisibility(): void {
    if (mesh) mesh.visible = mode !== 'off' && !bakeHidden;
  }

  // Swap the active mesh's material in place — used when toggling between
  // wireframe and shaded without regenerating the (expensive) geometry.
  function swapMaterial(toMode: Exclude<TerrainMode, 'off'>): void {
    if (!mesh) return;
    const old = mesh.material as THREE.Material;
    mesh.material = makeMaterial(toMode);
    old.dispose();
  }

  async function rebuild(camLoc: LatLng, buildMode: Exclude<TerrainMode, 'off'>): Promise<void> {
    const myBuildId = ++buildId;

    const cxFrac = lngToTileX(camLoc.lng, ZOOM);
    const cyFrac = latToTileY(camLoc.lat, ZOOM);
    const cx = Math.floor(cxFrac);
    const cy = Math.floor(cyFrac);

    // Fetch the (2R+1)×(2R+1) window in parallel.
    const tilePromises: Promise<{ tx: number; ty: number; data: Float32Array | null }>[] = [];
    for (let dy = -RADIUS_TILES; dy <= RADIUS_TILES; dy++) {
      for (let dx = -RADIUS_TILES; dx <= RADIUS_TILES; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        tilePromises.push(fetchTileElevations(ZOOM, tx, ty).then(data => ({ tx, ty, data })));
      }
    }
    const tiles = await Promise.all(tilePromises);
    if (myBuildId !== buildId) return; // a newer rebuild superseded us

    const tileMap = new Map<string, Float32Array>();
    for (const t of tiles) {
      if (t.data) tileMap.set(tileKey(ZOOM, t.tx, t.ty), t.data);
    }

    // Camera ground elevation: sample the centre tile at the camera's pixel.
    const centerTile = tileMap.get(tileKey(ZOOM, cx, cy));
    const camGroundElev = centerTile
      ? sampleTile(centerTile, (cxFrac - cx) * TILE_PX, (cyFrac - cy) * TILE_PX)
      : 0;

    // Build the mesh: one vertex per (sampled) DEM pixel across the tile window,
    // with seams welded by including the rightmost/topmost edge.
    const samplesPerTile = TILE_PX / SAMPLE_STRIDE;
    const nx = samplesPerTile * (RADIUS_TILES * 2 + 1) + 1;
    const ny = samplesPerTile * (RADIUS_TILES * 2 + 1) + 1;

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
      const ty = cy - RADIUS_TILES + tileJ;
      const py = (subJ === samplesPerTile) ? TILE_PX - 1 : subJ * SAMPLE_STRIDE;
      const lat = tileYToLat(ty + py / TILE_PX, ZOOM);
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
      const tx = cx - RADIUS_TILES + tileI;
      const px = (subI === samplesPerTile) ? TILE_PX - 1 : subI * SAMPLE_STRIDE;
      const lng = tileXToLng(tx + px / TILE_PX, ZOOM);
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
        const tile = tileMap.get(tileKey(ZOOM, tx, ty));
        const elev = tile ? tile[py * TILE_PX + px]! : 0;
        const idx = (j * nx + i) * 3;
        positions[idx] = colWx[i]!;
        positions[idx + 1] = elev - camGroundElev;
        positions[idx + 2] = wz;
      }
    }

    // Triangle indices. (nx-1)*(ny-1) quads, two triangles each.
    const quadCount = (nx - 1) * (ny - 1);
    // Use Uint32Array since vertex count can exceed 65535.
    const indices = new Uint32Array(quadCount * 6);
    let k = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
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
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    // Normals required for Lambert lighting; cheap enough to always compute so
    // wireframe→shaded swaps don't need a rebuild.
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = makeMaterial(buildMode);

    if (myBuildId !== buildId) {
      geometry.dispose();
      material.dispose();
      return;
    }

    disposeMesh();
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false; // bounding sphere is huge; we always want it on screen
    // Always draw before photo overlays (which use depthTest:false to stay on
    // top regardless of whether they physically intersect terrain).
    mesh.renderOrder = -1;
    applyVisibility();
    applyCameraHeight();
    scene.add(mesh);
    requestRender();
  }

  function maybeRebuild(): void {
    if (mode === 'off' || !location) {
      disposeMesh();
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
      // Wireframe↔shaded with a live mesh: just swap material, keep geometry.
      // Anything involving 'off' (or starting from no mesh) goes through rebuild.
      if (mesh && prev !== 'off' && value !== 'off') {
        swapMaterial(value);
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
