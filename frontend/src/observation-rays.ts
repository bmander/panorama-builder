// Observation rays for the selected other-station: gray to located CPs,
// purple 5km in the photo's (u, v) direction for null-location targets.

import * as THREE from 'three';
import { latLngToCameraRelativeMeters } from './geo.js';
import { buildPoseObject, widthFromSizeRad } from './overlay-photos.js';
import { clearLineGroup, makeOverlayLineSegments } from './overlay-lines.js';
import type { LatLng } from './types.js';

const PURPLE_RAY_LENGTH_M = 5000;
const PURPLE_COLOR = 0xa050ff;
const GRAY_COLOR = 0x808080;

export type ObservationRay =
  | {
      readonly kind: 'null';
      readonly fromLat: number;
      readonly fromLng: number;
      readonly fromAlt: number;
      readonly photoAz: number;
      readonly photoTilt: number;
      readonly photoRoll: number;
      readonly sizeRad: number;
      readonly aspect: number;
      readonly u: number;
      readonly v: number;
    }
  | {
      readonly kind: 'located';
      readonly fromLat: number;
      readonly fromLng: number;
      readonly fromAlt: number;
      readonly toLat: number;
      readonly toLng: number;
      // Null altitude terminates the ray at the active viewer's eye level
      // (y = 0), aligned with the column line drawn by map-poi-columns.
      readonly toAlt: number | null;
    };

export interface ObservationRays {
  update(camLoc: LatLng | null, cameraHeight: number, rays: readonly ObservationRay[]): void;
  setVisible(visible: boolean): void;
}

export interface CreateObservationRaysOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

export function createObservationRays(opts: CreateObservationRaysOptions): ObservationRays {
  const { scene, requestRender } = opts;

  const group = new THREE.Group();
  scene.add(group);
  const purpleMat = new THREE.LineBasicMaterial({
    color: PURPLE_COLOR,
    depthTest: false, depthWrite: false, transparent: true, fog: false,
  });
  const grayMat = new THREE.LineBasicMaterial({
    color: GRAY_COLOR,
    depthTest: false, depthWrite: false, transparent: true, fog: false,
  });

  const localPos = new THREE.Vector3();

  let lastCamLoc: LatLng | null = null;
  let lastCameraHeight = 0;
  let lastRays: readonly ObservationRay[] = [];

  function rebuild(): void {
    clearLineGroup(group);
    if (lastCamLoc === null || lastRays.length === 0) {
      requestRender();
      return;
    }
    let nNull = 0;
    let nLoc = 0;
    for (const r of lastRays) {
      if (r.kind === 'null') nNull++;
      else nLoc++;
    }
    const nullPositions = new Float32Array(nNull * 6);
    const locPositions = new Float32Array(nLoc * 6);
    let iN = 0;
    let iL = 0;
    for (const r of lastRays) {
      const offset = latLngToCameraRelativeMeters({ lat: r.fromLat, lng: r.fromLng }, lastCamLoc);
      const sx = offset.x;
      const sy = r.fromAlt - lastCameraHeight;
      const sz = offset.z;
      if (r.kind === 'null') {
        const pose = buildPoseObject(r.photoAz, r.photoTilt, r.photoRoll);
        const w = widthFromSizeRad(r.sizeRad);
        const h = w / r.aspect;
        localPos.set((r.u - 0.5) * w, (r.v - 0.5) * h, 0)
          .applyMatrix4(pose.matrixWorld)
          .normalize();
        nullPositions[iN++] = sx;
        nullPositions[iN++] = sy;
        nullPositions[iN++] = sz;
        nullPositions[iN++] = sx + localPos.x * PURPLE_RAY_LENGTH_M;
        nullPositions[iN++] = sy + localPos.y * PURPLE_RAY_LENGTH_M;
        nullPositions[iN++] = sz + localPos.z * PURPLE_RAY_LENGTH_M;
      } else {
        const toOffset = latLngToCameraRelativeMeters({ lat: r.toLat, lng: r.toLng }, lastCamLoc);
        const ey = r.toAlt === null ? 0 : r.toAlt - lastCameraHeight;
        locPositions[iL++] = sx;
        locPositions[iL++] = sy;
        locPositions[iL++] = sz;
        locPositions[iL++] = toOffset.x;
        locPositions[iL++] = ey;
        locPositions[iL++] = toOffset.z;
      }
    }
    if (nNull > 0) group.add(makeOverlayLineSegments(nullPositions, purpleMat));
    if (nLoc > 0) group.add(makeOverlayLineSegments(locPositions, grayMat));
    requestRender();
  }

  return {
    update(camLoc, cameraHeight, rays) {
      if (camLoc === lastCamLoc && cameraHeight === lastCameraHeight && rays === lastRays) return;
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
