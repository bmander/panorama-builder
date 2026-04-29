// DEM-driven terrain reference for the 360° viewer.
//
// Fetches AWS Open Data Terrain Tiles (Terrarium PNG encoding) and Esri World
// Imagery tiles around a camera location, builds Three.js meshes in real-world
// meters centered on the camera, and renders them in one of three modes:
//   - 'off'       — no meshes
//   - 'wireframe' — translucent blue wireframe (alignment ghost)
//   - 'shaded'    — Lambert-lit satellite imagery draped over the DEM
//
// Coverage is layered as concentric rings of progressively coarser zoom so
// distant features (e.g. peaks 100+ km away) appear without paying full
// inner-ring resolution everywhere. Ring sizing is driven by a target angular
// pitch per vertex — see the comment on RingSpec and the RINGS table.

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
import { fetchImageryTile } from './imagery.js';
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
// Fallback fill for the imagery canvas when individual tiles fail to load.
const IMAGERY_FALLBACK = '#888';
const DIR_LIGHT_INTENSITY = 2.5;
const AMBIENT_LIGHT_INTENSITY = 0.7;
// Far enough that direction is the only thing that matters; lambert ignores
// magnitude but Three.js still uses the position vector to build the direction.
const DIR_LIGHT_DISTANCE = 1000;

// Local-tangent-plane approximation: meters per degree latitude is roughly
// constant (Earth is round); per-degree longitude scales by cos(lat).
const M_PER_DEG_LAT = 111320;

// Curvature + standard atmospheric refraction. The geometric drop below the
// tangent plane at distance d from the camera is d²/(2R) (small-angle
// approximation; correct to <0.2 % at 525 km). Light refracts back toward
// Earth, raising apparent positions by k·d²/(2R); the surveyor's k = 0.14
// (the "0.0675 d² km" rule of thumb) cancels part of the drop. Net y-offset:
// −(1 − k) · d² / (2R), which reaches 73 m at 33 km, 608 m at 95 km, and
// 18.6 km at the outer ring's 525 km horizon.
const EARTH_RADIUS_M = 6371000;
const SURVEY_REFRACTION_K = 0.14;
const CURVATURE_DROP_FACTOR = (1 - SURVEY_REFRACTION_K) / (2 * EARTH_RADIUS_M);

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
function makeMaterial(
  mode: Exclude<TerrainMode, 'off'>,
  ringIndex: number,
  texture: THREE.Texture | null,
): THREE.Material {
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
  const lambert = new THREE.MeshLambertMaterial({
    map: texture,
    side: THREE.DoubleSide,
    polygonOffset,
    polygonOffsetFactor,
    polygonOffsetUnits,
  });
  // Heightfield normals all point ~up, so distant peaks above the camera
  // render via the back face — and Three.js samples the same UV from both
  // sides, which looks horizontally mirrored to the viewer. Flip UV.x on
  // back-facing fragments so the imagery reads correctly looking up.
  lambert.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec2 _terrainUv = gl_FrontFacing ? vMapUv : vec2(1.0 - vMapUv.x, vMapUv.y);
        vec4 sampledDiffuseColor = texture2D( map, _terrainUv );
        diffuseColor *= sampledDiffuseColor;
      #endif`,
    );
  };
  // Stable cache key so Three.js shares one compiled program across all our
  // ring materials instead of recompiling per instance.
  lambert.customProgramCacheKey = (): string => 'terrain-backface-uv-flip';
  return lambert;
}

interface RingResult {
  geometry: THREE.BufferGeometry;
  texture: THREE.Texture;
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

  // Fetch DEM and imagery for the (2R+1)×(2R+1) window in parallel.
  const demPromises: Promise<{ tx: number; ty: number; data: Float32Array | null }>[] = [];
  const imageryPromises: Promise<{ tx: number; ty: number; img: HTMLImageElement | null }>[] = [];
  for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
    for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
      const tx = cx + dx;
      const ty = cy + dy;
      demPromises.push(fetchTileElevations(zoom, tx, ty).then(data => ({ tx, ty, data })));
      imageryPromises.push(fetchImageryTile(zoom, tx, ty).then(img => ({ tx, ty, img })));
    }
  }
  const [tiles, imageryTiles] = await Promise.all([
    Promise.all(demPromises),
    Promise.all(imageryPromises),
  ]);

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
  const uvs = new Float32Array(nx * ny * 2);
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
      const wx = colWx[i]!;
      const drop = CURVATURE_DROP_FACTOR * (wx * wx + wz * wz);
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
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
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

  // Stitch the (2R+1)² imagery tiles into a single square canvas. Tile (cx-R,
  // cy-R) lands at the canvas's top-left, matching how UVs are assigned above
  // (UV.y=0 → vertex j=0 → northernmost row → top of canvas).
  const canvasSize = TILE_PX * (radiusTiles * 2 + 1);
  const canvas = document.createElement('canvas');
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = IMAGERY_FALLBACK;
  ctx.fillRect(0, 0, canvasSize, canvasSize);
  for (const t of imageryTiles) {
    if (!t.img) continue;
    const ox = (t.tx - (cx - radiusTiles)) * TILE_PX;
    const oy = (t.ty - (cy - radiusTiles)) * TILE_PX;
    ctx.drawImage(t.img, ox, oy);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  // The canvas is drawn with north at y=0 already, so disable the default
  // flip so UV.y = j/(ny-1) lines up directly: j=0 (north vertex) → UV.y=0
  // → canvas top → north tile.
  texture.flipY = false;

  return { geometry, texture, camGroundElev, bounds };
}

export function createTerrainView({ scene, requestRender }: CreateTerrainViewOptions): TerrainView {
  let mode: TerrainMode = 'off';
  let bakeHidden = false;
  let location: LatLng | null = null;
  let meshes: THREE.Mesh[] = [];
  // Parallel to `meshes`. Kept separately so swapMaterials (wireframe ↔ shaded)
  // can rebuild a Lambert material with the same imagery `map` without going
  // back to the network.
  let textures: THREE.Texture[] = [];
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
    for (const t of textures) t.dispose();
    meshes = [];
    textures = [];
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
      m.material = makeMaterial(toMode, ringIndex, textures[ringIndex] ?? null);
      old.dispose();
    });
  }

  async function rebuild(camLoc: LatLng, buildMode: Exclude<TerrainMode, 'off'>): Promise<void> {
    const myBuildId = ++buildId;

    // Kick off every ring's DEM and imagery fetches before awaiting any: the
    // dem/imagery modules dedupe via their inflight maps, so this just warms
    // the caches so outer rings' network round-trips overlap with the inner
    // ring's geometry build instead of running serially after it.
    for (const spec of RINGS) {
      const cx = Math.floor(lngToTileX(camLoc.lng, spec.zoom));
      const cy = Math.floor(latToTileY(camLoc.lat, spec.zoom));
      for (let dy = -spec.radiusTiles; dy <= spec.radiusTiles; dy++) {
        for (let dx = -spec.radiusTiles; dx <= spec.radiusTiles; dx++) {
          void fetchTileElevations(spec.zoom, cx + dx, cy + dy);
          void fetchImageryTile(spec.zoom, cx + dx, cy + dy);
        }
      }
    }

    // Build inner ring first to fix camGroundElev; outer rings reuse it so the
    // meshes line up cleanly at boundaries. Each ring's outer coverage is
    // passed to the next so it can carve a matching hole and avoid z-fighting.
    const builtGeometries: THREE.BufferGeometry[] = [];
    const builtTextures: THREE.Texture[] = [];
    let prev: { camGroundElev: number; bounds: RingBounds } | undefined;
    for (const spec of RINGS) {
      const result = await buildRing(camLoc, spec, prev);
      if (myBuildId !== buildId) {
        for (const g of builtGeometries) g.dispose();
        for (const t of builtTextures) t.dispose();
        result.geometry.dispose();
        result.texture.dispose();
        return;
      }
      prev = { camGroundElev: result.camGroundElev, bounds: result.bounds };
      builtGeometries.push(result.geometry);
      builtTextures.push(result.texture);
    }

    disposeMeshes();
    builtGeometries.forEach((geometry, ringIndex) => {
      const texture = builtTextures[ringIndex]!;
      const mesh = new THREE.Mesh(geometry, makeMaterial(buildMode, ringIndex, texture));
      mesh.frustumCulled = false; // bounding sphere is huge; we always want it on screen
      // Always draw before photo overlays (which use depthTest:false to stay on
      // top regardless of whether they physically intersect terrain).
      mesh.renderOrder = -1;
      scene.add(mesh);
      meshes.push(mesh);
      textures.push(texture);
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
