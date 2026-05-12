// DEM-driven terrain reference for the 360° viewer.
//
// Fetches AWS Open Data Terrain Tiles (Terrarium PNG encoding) and Esri World
// Imagery tiles around a camera location, builds Three.js meshes in real-world
// meters centered on the camera, and renders them in one of three modes:
//   - 'off'       — no meshes
//   - 'wireframe' — translucent blue wireframe (alignment ghost)
//   - 'shaded'    — Lambert-lit satellite imagery draped over the DEM
//
// Coverage is layered as concentric rings of progressively finer zoom so
// distant features (e.g. peaks 100+ km away) appear without paying full
// inner-ring resolution everywhere. Ring layout is derived from a target
// angular resolution — see computeRings and its comment block.

import * as THREE from 'three';
import type { LatLng } from '../types.js';
import { sunDirection } from '../solar.js';
import { latLngToCameraRelativeMeters } from '../geo.js';
import {
  getCurvatureEnabled,
  getCurvatureFactor,
  getRefractionEnabled,
  setCurvatureEnabled,
  setRefractionEnabled,
  subscribeCurvatureChange,
} from '../curvature.js';
import {
  buildRingGeometry,
  computeRings,
  ringBounds,
} from './geometry.js';
import {
  fetchCamGroundElev,
  loadRingTiles,
  prefetchRingTiles,
  stitchImageryCanvas,
} from './tiles.js';

const WIREFRAME_COLOR = 0x88aaff;
const WIREFRAME_OPACITY = 0.35;
const DIR_LIGHT_INTENSITY = 2.5;
const AMBIENT_LIGHT_INTENSITY = 0.7;
// Far enough that direction is the only thing that matters; lambert ignores
// magnitude but Three.js still uses the position vector to build the direction.
const DIR_LIGHT_DISTANCE = 1000;

export type TerrainMode = 'off' | 'wireframe' | 'shaded';

export interface TerrainView {
  setLocation(camLoc: LatLng | null): void;
  setMode(mode: TerrainMode): void;
  getMode(): TerrainMode;
  // Earth-curvature drop applied to each vertex (`d² / (2R)`). Off = flat
  // tangent-plane; distant peaks sit too high in the model. On = correct.
  setCurvatureEnabled(enabled: boolean): void;
  getCurvatureEnabled(): boolean;
  // Standard surveyor's atmospheric-refraction correction. Multiplies the
  // curvature drop by (1 - k) where k = 0.14. Only meaningful when curvature
  // is on; setting it without curvature is a no-op.
  setRefractionEnabled(enabled: boolean): void;
  getRefractionEnabled(): boolean;
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

// Adjacent rings cut cleanly on a shared vertex grid — see computeRings'
// invariant. No polygon-offset bias needed.
function makeMaterial(
  mode: Exclude<TerrainMode, 'off'>,
  texture: THREE.Texture | null,
): THREE.Material {
  if (mode === 'wireframe') {
    return new THREE.MeshBasicMaterial({
      color: WIREFRAME_COLOR,
      wireframe: true,
      transparent: true,
      opacity: WIREFRAME_OPACITY,
      depthWrite: false,
    });
  }
  const lambert = new THREE.MeshLambertMaterial({
    map: texture,
    side: THREE.DoubleSide,
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

export function createTerrainView({ scene, requestRender }: CreateTerrainViewOptions): TerrainView {
  let mode: TerrainMode = 'off';
  let location: LatLng | null = null;
  // Build origin of the current meshes. Vertex positions are stored relative
  // to this, so live-camera moves translate the group (cheap) until the
  // camera leaves the inner-ring tile window and a real rebuild is needed.
  let builtLocation: LatLng | null = null;
  // Inner ring at zoom 11 covers ~50–80 km on a side; rebuilding when the
  // camera has moved 5 km from the build origin keeps a comfortable margin.
  const REBUILD_DIST_THRESHOLD_M = 5000;
  // All ring meshes ride on this group. group.position carries both the
  // camera-height y-offset and the camera-vs-builtLocation x/z translation.
  const terrainGroup = new THREE.Group();
  scene.add(terrainGroup);
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

  function applyGroupTransform(): void {
    if (location && builtLocation) {
      // Translate by the build origin's position in the current camera frame:
      // a vertex stored at the origin (the build point) renders at exactly
      // that offset from the live camera.
      const o = latLngToCameraRelativeMeters(builtLocation, location);
      terrainGroup.position.set(o.x, -cameraHeight, o.z);
    } else {
      terrainGroup.position.set(0, -cameraHeight, 0);
    }
  }

  function disposeMeshes(): void {
    for (const m of meshes) {
      terrainGroup.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const t of textures) t.dispose();
    meshes = [];
    textures = [];
  }

  function applyVisibility(): void {
    const visible = mode !== 'off';
    for (const m of meshes) m.visible = visible;
  }

  // Swap each mesh's material in place — used when toggling between wireframe
  // and shaded without regenerating the (expensive) geometry.
  function swapMaterials(toMode: Exclude<TerrainMode, 'off'>): void {
    meshes.forEach((m, ringIndex) => {
      const old = m.material as THREE.Material;
      m.material = makeMaterial(toMode, textures[ringIndex] ?? null);
      old.dispose();
    });
  }

  async function rebuild(camLoc: LatLng, buildMode: Exclude<TerrainMode, 'off'>): Promise<void> {
    const myBuildId = ++buildId;
    // computeRings() returns innermost first (z=14 → z=8), which is the
    // same order display proceeds in: the camera's immediate surroundings
    // land first, then progressively wider rings fill in toward the horizon.
    const rings = computeRings();
    const factor = getCurvatureFactor();
    const innermost = rings[0]!;

    // Kick the elevation-anchor fetch off first so it sits at the head of
    // the browser's tile queue — every subsequent ring build needs it.
    const camGroundElevPromise = fetchCamGroundElev(camLoc, innermost);
    for (const spec of rings) prefetchRingTiles(camLoc, spec);

    const camGroundElev = await camGroundElevPromise;
    if (myBuildId !== buildId) return;

    // Each ring's hole is the next-finer ring's outer rectangle — pure
    // function of camLoc + spec, no tile data needed. The innermost ring
    // (index 0) has no finer neighbor and so no hole.
    const holes = rings.map((_, i) => {
      const innerSpec = rings[i - 1];
      return innerSpec ? ringBounds(camLoc, innerSpec) : undefined;
    });

    interface Built { geometry: THREE.BufferGeometry; texture: THREE.Texture }
    const disposeBuilt = (b: Built | null): void => {
      if (b) { b.geometry.dispose(); b.texture.dispose(); }
    };

    // Build every ring concurrently. Each disposes its own products on
    // cancellation; the orchestrator only consumes results in inner-first
    // order so display proceeds strictly inner→outer.
    const buildPromises = rings.map(async (spec, i): Promise<Built | null> => {
      const { demTiles, imageryTiles } = await loadRingTiles(camLoc, spec);
      if (myBuildId !== buildId) return null;
      const geom = buildRingGeometry(camLoc, spec, factor, demTiles, camGroundElev, holes[i]);
      const canvas = stitchImageryCanvas(camLoc, spec, imageryTiles);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(geom.positions, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(geom.uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(geom.indices, 1));
      // Normals required for Lambert lighting; cheap enough to always compute so
      // wireframe→shaded swaps don't need a rebuild.
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      // The canvas is drawn with north at y=0 already, so disable the default
      // flip so UV.y = j/(ny-1) lines up directly: j=0 (north vertex) → UV.y=0
      // → canvas top → north tile.
      texture.flipY = false;

      if (myBuildId !== buildId) {
        geometry.dispose();
        texture.dispose();
        return null;
      }
      return { geometry, texture };
    });

    // Defer disposing the previous build until the first new ring is in
    // hand: keeps old terrain on screen during the build instead of
    // showing a blank scene.
    let swapped = false;
    for (let i = 0; i < buildPromises.length; i++) {
      const result = await buildPromises[i]!;
      if (myBuildId !== buildId) {
        disposeBuilt(result);
        for (let j = i + 1; j < buildPromises.length; j++) {
          void buildPromises[j]!.then(disposeBuilt);
        }
        return;
      }
      if (!result) continue;
      if (!swapped) {
        disposeMeshes();
        builtLocation = camLoc;
        applyGroupTransform();
        applyVisibility();
        swapped = true;
      }
      const mesh = new THREE.Mesh(result.geometry, makeMaterial(buildMode, result.texture));
      mesh.frustumCulled = false; // bounding sphere is huge; we always want it on screen
      // Always draw before photo overlays (which use depthTest:false to stay on
      // top regardless of whether they physically intersect terrain).
      mesh.renderOrder = -1;
      terrainGroup.add(mesh);
      meshes.push(mesh);
      textures.push(result.texture);
      requestRender();
    }
  }

  function maybeRebuild(): void {
    if (mode === 'off' || !location) {
      // Bump buildId to cancel any in-flight rebuild; otherwise its
      // remaining attaches would land in a scene we just emptied.
      ++buildId;
      disposeMeshes();
      builtLocation = null;
      applyGroupTransform();
      requestRender();
      return;
    }
    void rebuild(location, mode);
  }

  // Rebuild terrain whenever the curvature factor effectively changes
  // (curvature on/off, or refraction toggled while curvature is on).
  subscribeCurvatureChange(maybeRebuild);

  // Distance² from current location to the build origin, in m². Used to
  // decide whether a rebuild is needed instead of just translating.
  function distSqFromBuilt(): number {
    if (!location || !builtLocation) return Infinity;
    const { x, z } = latLngToCameraRelativeMeters(location, builtLocation);
    return x * x + z * z;
  }

  return {
    setLocation(camLoc) {
      location = camLoc;
      // Translate the mesh group to follow the camera. For in-window moves
      // this is the whole update — no rebuild needed. The translation also
      // keeps the old meshes correctly positioned during an in-flight
      // rebuild after a large jump.
      applyGroupTransform();
      requestRender();
      // Trigger a real rebuild only when the camera leaves the safe zone of
      // the current build (e.g., the first location after startup, or the
      // user dropping a faraway pin).
      if (meshes.length === 0 || distSqFromBuilt() >= REBUILD_DIST_THRESHOLD_M * REBUILD_DIST_THRESHOLD_M) {
        maybeRebuild();
      }
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
    // Curvature / refraction state lives in ../curvature.js so the CP
    // renderers can read the same factor. subscribeCurvatureChange above
    // rebuilds terrain when the effective factor moves.
    setCurvatureEnabled,
    getCurvatureEnabled,
    setRefractionEnabled,
    getRefractionEnabled,
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
      applyGroupTransform();
      requestRender();
      return true;
    },
    getCameraHeight: () => cameraHeight,
  };
}
