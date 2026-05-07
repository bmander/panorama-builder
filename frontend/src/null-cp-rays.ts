// Purple 5km rays drawn from each photo that observes a null-location CP,
// pointing in the (u, v) direction the photo is looking. Visible in the
// 360° viewer when the user enables it from the settings panel — lets them
// visually triangulate where to add their own observation for a CP that
// hasn't been triangulated yet.
//
// Geometry: one LineSegment per ray; the start is the observing station's
// camera at (east, fromAlt − cameraHeight, south) so the ray meets the
// station marker (which uses the same y = altitude − cameraHeight). The
// direction is recovered from the photo's pose using the same Three.js
// transform the live photo overlay uses (placeAt + rotateZ), so a ray and
// its source photo overlay agree on bearing.

import * as THREE from 'three';
import { latLngToCameraRelativeMeters } from './geo.js';
import { dirFromAzAlt, OVERLAY_R, widthFromSizeRad } from './overlay-photos.js';
import { OVERLAY_RENDER_ORDER } from './dot-layer.js';
import { radToDeg } from './mathx.js';
import type { LatLng } from './types.js';

const RAY_LENGTH_M = 5000;
const RAY_COLOR = 0xa050ff;
export const NULL_CP_RAY_LENGTH_M = RAY_LENGTH_M;
export const NULL_CP_RAY_CSS = '#a050ff';

const bearingScratchObj = new THREE.Object3D();
const bearingScratchVec = new THREE.Vector3();

// Compass bearing (CW from N, in degrees) of the ray emitted from a photo
// at (u, v) given its pose. Same world-direction math as the 3D ray
// rebuilder; the y component is dropped before atan2.
export function nullCpRayBearingDeg(
  photoAz: number, photoTilt: number, photoRoll: number,
  sizeRad: number, aspect: number, u: number, v: number,
): number {
  bearingScratchObj.position.copy(dirFromAzAlt(photoAz, photoTilt))
    .normalize().multiplyScalar(OVERLAY_R);
  bearingScratchObj.lookAt(0, 0, 0);
  if (photoRoll !== 0) bearingScratchObj.rotateZ(photoRoll);
  bearingScratchObj.updateMatrixWorld();
  const w = widthFromSizeRad(sizeRad);
  const h = w / aspect;
  bearingScratchVec.set((u - 0.5) * w, (v - 0.5) * h, 0)
    .applyMatrix4(bearingScratchObj.matrixWorld);
  // Viewer frame: +x = east, +z = south. Compass = atan2(east, north).
  return radToDeg(Math.atan2(bearingScratchVec.x, -bearingScratchVec.z));
}

export interface NullCpRay {
  readonly fromLat: number;
  readonly fromLng: number;
  // Observing station's elevation in meters above sea level — converted to
  // viewer-y as fromAlt − cameraHeight to match station-marker placement.
  readonly fromAlt: number;
  readonly photoAz: number;
  readonly photoTilt: number;
  readonly photoRoll: number;
  readonly sizeRad: number;
  readonly aspect: number;
  readonly u: number;
  readonly v: number;
}

export interface NullCpRays {
  update(camLoc: LatLng | null, cameraHeight: number, rays: readonly NullCpRay[]): void;
  setVisible(visible: boolean): void;
}

export interface CreateNullCpRaysOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

export function createNullCpRays(opts: CreateNullCpRaysOptions): NullCpRays {
  const { scene, requestRender } = opts;

  const group = new THREE.Group();
  scene.add(group);
  const mat = new THREE.LineBasicMaterial({
    color: RAY_COLOR,
    depthTest: false, depthWrite: false, transparent: true, fog: false,
  });

  const tempObj = new THREE.Object3D();
  const localPos = new THREE.Vector3();

  let lastCamLoc: LatLng | null = null;
  let lastCameraHeight = 0;
  let lastRays: readonly NullCpRay[] = [];

  function clearGeom(): void {
    for (const child of group.children) {
      if (child instanceof THREE.LineSegments) {
        (child.geometry as THREE.BufferGeometry).dispose();
      }
    }
    group.clear();
  }

  function rebuild(): void {
    clearGeom();
    if (lastCamLoc === null || lastRays.length === 0) {
      requestRender();
      return;
    }
    const positions = new Float32Array(lastRays.length * 6);
    let i = 0;
    for (const r of lastRays) {
      const offset = latLngToCameraRelativeMeters({ lat: r.fromLat, lng: r.fromLng }, lastCamLoc);
      const sx = offset.x, sy = r.fromAlt - lastCameraHeight, sz = offset.z;

      // Match the live photo overlay: place at OVERLAY_R in the pose
      // direction, look at the camera origin, then apply roll.
      tempObj.position.copy(dirFromAzAlt(r.photoAz, r.photoTilt))
        .normalize().multiplyScalar(OVERLAY_R);
      tempObj.lookAt(0, 0, 0);
      if (r.photoRoll !== 0) tempObj.rotateZ(r.photoRoll);
      tempObj.updateMatrixWorld();

      const w = widthFromSizeRad(r.sizeRad);
      const h = w / r.aspect;
      localPos.set((r.u - 0.5) * w, (r.v - 0.5) * h, 0)
        .applyMatrix4(tempObj.matrixWorld)
        .normalize();

      positions[i++] = sx;
      positions[i++] = sy;
      positions[i++] = sz;
      positions[i++] = sx + localPos.x * RAY_LENGTH_M;
      positions[i++] = sy + localPos.y * RAY_LENGTH_M;
      positions[i++] = sz + localPos.z * RAY_LENGTH_M;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const segs = new THREE.LineSegments(geom, mat);
    segs.renderOrder = OVERLAY_RENDER_ORDER;
    segs.frustumCulled = false;
    group.add(segs);
    requestRender();
  }

  return {
    update(camLoc, cameraHeight, rays) {
      lastCamLoc = camLoc;
      lastCameraHeight = cameraHeight;
      lastRays = rays;
      rebuild();
    },
    setVisible(visible) {
      group.visible = visible;
      requestRender();
    },
  };
}
