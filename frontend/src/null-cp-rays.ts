// Bearing helper + style constants for the index-page map's null-CP ray
// feature, which renders 5 km purple lines from each photo that observes
// a null-location CP. The 3D scene rendering for the station-page viewer
// lives in observation-rays.ts (purple + gray, gated on cone selection).

import * as THREE from 'three';
import { buildPoseObject, widthFromSizeRad } from './overlay-photos.js';
import { radToDeg } from './mathx.js';

export const NULL_CP_RAY_LENGTH_M = 5000;
export const NULL_CP_RAY_CSS = '#a050ff';

const bearingScratchVec = new THREE.Vector3();

// Compass bearing (CW from N, in degrees) of the ray emitted from a photo
// at (u, v) given its pose. y is dropped before atan2.
export function nullCpRayBearingDeg(
  photoAz: number, photoTilt: number, photoRoll: number,
  sizeRad: number, aspect: number, u: number, v: number,
): number {
  const pose = buildPoseObject(photoAz, photoTilt, photoRoll);
  const w = widthFromSizeRad(sizeRad);
  const h = w / aspect;
  bearingScratchVec.set((u - 0.5) * w, (v - 0.5) * h, 0)
    .applyMatrix4(pose.matrixWorld);
  // Viewer frame: +x = east, +z = south. Compass = atan2(east, north).
  return radToDeg(Math.atan2(bearingScratchVec.x, -bearingScratchVec.z));
}
