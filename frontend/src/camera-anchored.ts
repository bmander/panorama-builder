// Shared positioning helper for the build-once / translate-per-frame
// overlay pattern (see dot-layer, observation-rays, station-cones).
//
// Each overlay builds its geometry in coords relative to the camera at
// build time (`builtCamLoc`, `builtCameraMSL`); on subsequent updates
// where only the camera moved, the group is translated instead of
// rebuilding the BufferGeometry — same trick `terrain/index.ts` uses.

import * as THREE from 'three';
import { curvatureDrop } from './curvature.js';
import { latLngToCameraRelativeMeters, tangentMetersToLatLng } from './geo.js';
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

// Camera-relative 3D position of an MSL-anchored point, including curvature
// drop. The same transform every camera-anchored overlay uses.
export function latLngAltVertex(
  latlng: LatLng, altitude: number, camLoc: LatLng, cameraMSL: number,
): THREE.Vector3 {
  const { x, z } = latLngToCameraRelativeMeters(latlng, camLoc);
  const y = altitude - cameraMSL - curvatureDrop(x * x + z * z);
  return new THREE.Vector3(x, y, z);
}

// Same transform applied to a control point's estimate. Returns null when
// the CP isn't fully located.
export function controlPointVertex(
  cp: ControlPointView, camLoc: LatLng, cameraMSL: number,
): THREE.Vector3 | null {
  if (cp.estLat === null || cp.estLng === null || cp.estAlt === null) return null;
  return latLngAltVertex({ lat: cp.estLat, lng: cp.estLng }, cp.estAlt, camLoc, cameraMSL);
}

// Inverse of latLngAltVertex: a camera-relative point back into a stable
// lat/lng/altitude. Picker UIs use this to record what the user clicked in
// a representation that survives camera movement.
export function vertexToLatLngAlt(
  point: THREE.Vector3, camLoc: LatLng, cameraMSL: number,
): { latlng: LatLng; altitude: number } {
  const latlng = tangentMetersToLatLng(camLoc, point.x, point.z);
  const altitude = point.y + cameraMSL + curvatureDrop(point.x * point.x + point.z * point.z);
  return { latlng, altitude };
}
