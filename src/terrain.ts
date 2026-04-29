// DEM-driven terrain ghost for the 360° viewer.
//
// Fetches AWS Open Data Terrain Tiles (Terrarium PNG encoding) around a camera
// location, decodes elevations, builds a Three.js mesh in real-world meters
// centered on the camera, and renders it as a wireframe ghost behind the photo
// overlays. Used as a manual-alignment aid; future passes can layer
// auto-matching on top.
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

const ZOOM = 11;
const RADIUS_TILES = 2;             // 5×5 = (2*R+1)^2 tiles around centre
const SAMPLE_STRIDE = 2;             // every other DEM pixel → ~110 m spacing at zoom 11
const COLOR = 0x88aaff;
const OPACITY = 0.35;

// Local-tangent-plane approximation: meters per degree latitude is roughly
// constant (Earth is round); per-degree longitude scales by cos(lat).
const M_PER_DEG_LAT = 111320;

// Sample elevation at fractional pixel coords within a tile (nearest-neighbor).
function sampleTile(elev: Float32Array, px: number, py: number): number {
  const ix = Math.max(0, Math.min(TILE_PX - 1, Math.floor(px)));
  const iy = Math.max(0, Math.min(TILE_PX - 1, Math.floor(py)));
  return elev[iy * TILE_PX + ix]!;
}

export interface TerrainView {
  setLocation(camLoc: LatLng | null): void;
  setEnabled(enabled: boolean): void;
  setBakeVisible(visible: boolean): void;
  isEnabled(): boolean;
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

export function createTerrainView({ scene, requestRender }: CreateTerrainViewOptions): TerrainView {
  let enabled = false;
  let bakeHidden = false;
  let location: LatLng | null = null;
  let mesh: THREE.Mesh | null = null;
  let buildId = 0;
  let cameraHeight = 0;

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
    if (mesh) mesh.visible = enabled && !bakeHidden;
  }

  async function rebuild(camLoc: LatLng): Promise<void> {
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
    geometry.computeBoundingSphere();

    const material = new THREE.MeshBasicMaterial({
      color: COLOR,
      wireframe: true,
      transparent: true,
      opacity: OPACITY,
      depthWrite: false,
    });

    if (myBuildId !== buildId) {
      geometry.dispose();
      material.dispose();
      return;
    }

    disposeMesh();
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false; // bounding sphere is huge; we always want it on screen
    applyVisibility();
    applyCameraHeight();
    scene.add(mesh);
    requestRender();
  }

  function maybeRebuild(): void {
    if (!enabled || !location) {
      disposeMesh();
      requestRender();
      return;
    }
    void rebuild(location);
  }

  return {
    setLocation(camLoc) {
      location = camLoc;
      maybeRebuild();
    },
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      maybeRebuild();
    },
    setBakeVisible(visible) {
      bakeHidden = !visible;
      applyVisibility();
    },
    isEnabled: () => enabled,
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
