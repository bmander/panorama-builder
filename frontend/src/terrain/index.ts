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
import { latLngToCameraRelativeMeters } from '../geo.js';
import { applyGroupTransform as applyAnchoredTransform } from '../camera-anchored.js';
import { getCurvatureFactor, subscribeCurvatureChange } from '../curvature.js';
import { buildTerrainSnapshot } from './builder.js';
import { createTerrainSceneLayer } from './scene-layer.js';

export type TerrainMode = 'off' | 'wireframe' | 'shaded';

export interface TerrainView {
  setLocation(camLoc: LatLng | null): void;
  setMode(mode: TerrainMode): void;
  getMode(): TerrainMode;
  // Sun direction for the 'shaded' mode. Azimuth is radians from north
  // clockwise; altitude is radians above the horizon. Negative altitudes are
  // accepted (sun below horizon → terrain falls into ambient-only).
  setSunDirection(az: number, alt: number): void;
  // Camera elevation in meters above mean sea level. Implemented as a y-offset
  // on every ring mesh (groupY = camGroundElevAtBuilt − cameraMSL) — the
  // panorama camera stays at the scene origin so photo overlays continue to
  // wrap correctly around it.
  // Returns true if the value actually changed; lets callers skip downstream
  // refresh/save work when wheel events repeat the same MSL.
  setCameraMSL(meters: number): boolean;
  // Derived: camera's height above the local DEM ground at the mesh's build
  // location. HUD-only; non-terrain renderers should read altitude from the
  // shared world-camera pose, not from here.
  getCameraHeightAboveGround(): number;
}

export interface CreateTerrainViewOptions {
  scene: THREE.Scene;
  requestRender: () => void;
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
  const sceneLayer = createTerrainSceneLayer({ scene });
  let currentAbort: AbortController | null = null;
  let cameraMSL = 0;
  let camGroundElevAtBuilt = 0;
  let sunAz = Math.PI;       // default: due south
  let sunAlt = Math.PI / 4;  // default: 45° up

  function applyGroupTransform(): void {
    // Vertex Y is stored as (vertex_MSL − camGroundElevAtBuilt), so the
    // build-time vertical reference fed to the shared anchored-transform
    // helper IS camGroundElevAtBuilt: the helper shifts y by
    // (builtCameraMSL − cameraMSL), putting each vertex at viewer
    // y = vertex_MSL − cameraMSL.
    applyAnchoredTransform(sceneLayer.group, builtLocation, camGroundElevAtBuilt, location, cameraMSL);
  }

  async function rebuild(camLoc: LatLng, buildMode: Exclude<TerrainMode, 'off'>): Promise<void> {
    currentAbort?.abort();
    const controller = new AbortController();
    currentAbort = controller;

    try {
      // Defer disposing the previous build until the first new ring is in
      // hand: keeps old terrain on screen during the build instead of
      // showing a blank scene.
      let swapped = false;
      for await (const ring of buildTerrainSnapshot(
        { camLoc, curvatureFactor: getCurvatureFactor() },
        controller.signal,
      )) {
        if (!swapped) {
          sceneLayer.clear();
          builtLocation = camLoc;
          camGroundElevAtBuilt = ring.camGroundElev;
          applyGroupTransform();
          sceneLayer.setVisible(mode !== 'off');
          swapped = true;
        }
        sceneLayer.attachRing(ring, buildMode);
        requestRender();
      }
    } finally {
      // Drop the reference if we're the most recent rebuild; a newer rebuild
      // would have already swapped the slot to its own controller.
      if (currentAbort === controller) currentAbort = null;
    }
  }

  function maybeRebuild(): void {
    if (mode === 'off' || !location) {
      currentAbort?.abort();
      sceneLayer.clear();
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
      if (sceneLayer.ringCount() === 0 || distSqFromBuilt() >= REBUILD_DIST_THRESHOLD_M * REBUILD_DIST_THRESHOLD_M) {
        maybeRebuild();
      }
    },
    setMode(value) {
      if (mode === value) return;
      const prev = mode;
      mode = value;
      // Wireframe↔shaded with live meshes: just swap materials, keep geometry.
      // Anything involving 'off' (or starting from no meshes) goes through rebuild.
      if (sceneLayer.ringCount() > 0 && prev !== 'off' && value !== 'off') {
        sceneLayer.swapMaterials(value);
        sceneLayer.setVisible(true);
        requestRender();
      } else {
        maybeRebuild();
      }
    },
    getMode: () => mode,
    setSunDirection(az, alt) {
      if (sunAz === az && sunAlt === alt) return;
      sunAz = az;
      sunAlt = alt;
      sceneLayer.setSunDirection(az, alt);
      if (mode === 'shaded') requestRender();
    },
    setCameraMSL(meters) {
      if (cameraMSL === meters) return false;
      cameraMSL = meters;
      applyGroupTransform();
      requestRender();
      return true;
    },
    getCameraHeightAboveGround: () => cameraMSL - camGroundElevAtBuilt,
  };
}
