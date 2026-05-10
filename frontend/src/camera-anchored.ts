// Shared positioning helper for the build-once / translate-per-frame
// overlay pattern (see dot-layer, observation-rays, station-cones).
//
// Each overlay builds its geometry in coords relative to the camera at
// build time (`builtCamLoc`, `builtCameraHeight`); on subsequent updates
// where only the camera moved, the group is translated instead of
// rebuilding the BufferGeometry — same trick `terrain/index.ts` uses.

import * as THREE from 'three';
import { latLngToCameraRelativeMeters } from './geo.js';
import type { LatLng } from './types.js';

export function applyGroupTransform(
  group: THREE.Group,
  builtCamLoc: LatLng | null,
  builtCameraHeight: number,
  camLoc: LatLng | null,
  cameraHeight: number,
): void {
  if (builtCamLoc === null || camLoc === null) {
    group.position.set(0, 0, 0);
    return;
  }
  const o = latLngToCameraRelativeMeters(builtCamLoc, camLoc);
  group.position.set(o.x, builtCameraHeight - cameraHeight, o.z);
}
