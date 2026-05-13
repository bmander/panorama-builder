// Shared positioning helper for the build-once / translate-per-frame
// overlay pattern (see dot-layer, observation-rays, station-cones).
//
// Each overlay builds its geometry in coords relative to the camera at
// build time (`builtCamLoc`, `builtCameraMSL`); on subsequent updates
// where only the camera moved, the group is translated instead of
// rebuilding the BufferGeometry — same trick `terrain/index.ts` uses.

import * as THREE from 'three';
import { curvatureDrop } from './curvature.js';
import { latLngToCameraRelativeMeters } from './geo.js';
import type { ControlPointView, LatLng } from './types.js';

export function applyGroupTransform(
  group: THREE.Group,
  builtCamLoc: LatLng | null,
  builtCameraMSL: number,
  camLoc: LatLng | null,
  cameraMSL: number,
): void {
  if (builtCamLoc === null || camLoc === null) {
    group.position.set(0, 0, 0);
    return;
  }
  const o = latLngToCameraRelativeMeters(builtCamLoc, camLoc);
  group.position.set(o.x, builtCameraMSL - cameraMSL, o.z);
}

// Camera-relative 3D position of a control point's estimate, including
// curvature drop. Returns null when the CP isn't fully located.
export function controlPointVertex(
  cp: ControlPointView, camLoc: LatLng, cameraMSL: number,
): THREE.Vector3 | null {
  if (cp.estLat === null || cp.estLng === null || cp.estAlt === null) return null;
  const { x, z } = latLngToCameraRelativeMeters({ lat: cp.estLat, lng: cp.estLng }, camLoc);
  const y = cp.estAlt - cameraMSL - curvatureDrop(x * x + z * z);
  return new THREE.Vector3(x, y, z);
}
