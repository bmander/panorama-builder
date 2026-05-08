// Blender-style frustum pyramids for every photo at every other station,
// drawn in the active station's photosphere so direction (and, via apparent
// size, distance) of each external camera is visible at a glance. Apex sits
// at the other station's lens position; base extends CONE_DEPTH_M in the
// photo's pointing direction with half-extents derived from sizeRad/aspect.
//
// Mirrors the structure of null-cp-rays.ts: one batched LineSegments per
// frame, recomputed in update() against the current camLoc / cameraHeight.

import * as THREE from 'three';
import { latLngToCameraRelativeMeters } from './geo.js';
import { dirFromAzAlt } from './overlay-photos.js';
import { clearLineGroup, makeOverlayLineSegments } from './overlay-lines.js';
import type { LatLng } from './types.js';

const CONE_DEPTH_M = 4.0;
const CONE_COLOR = 0x80c0ff;

export interface StationCone {
  readonly fromLat: number;
  readonly fromLng: number;
  readonly fromAlt: number;
  readonly photoAz: number;
  readonly photoTilt: number;
  readonly photoRoll: number;
  readonly sizeRad: number;
  readonly aspect: number;
}

export interface StationCones {
  update(camLoc: LatLng | null, cameraHeight: number, cones: readonly StationCone[]): void;
  setVisible(visible: boolean): void;
}

export interface CreateStationConesOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

export function createStationCones(opts: CreateStationConesOptions): StationCones {
  const { scene, requestRender } = opts;

  const group = new THREE.Group();
  scene.add(group);
  const mat = new THREE.LineBasicMaterial({
    color: CONE_COLOR,
    depthTest: false, depthWrite: false, transparent: true, fog: false,
  });

  const tempObj = new THREE.Object3D();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  let lastCamLoc: LatLng | null = null;
  let lastCameraHeight = 0;
  let lastCones: readonly StationCone[] = [];

  function rebuild(): void {
    clearLineGroup(group);
    if (lastCamLoc === null || lastCones.length === 0) {
      requestRender();
      return;
    }
    const positions = new Float32Array(lastCones.length * 48);
    let i = 0;
    for (const c of lastCones) {
      const offset = latLngToCameraRelativeMeters({ lat: c.fromLat, lng: c.fromLng }, lastCamLoc);
      const ax = offset.x;
      const ay = c.fromAlt - lastCameraHeight;
      const az = offset.z;

      // Build the photo's local frame using the same trick as
      // null-cp-rays.ts:114-118 — position at unit dir from origin, look
      // back at origin, then apply roll. The matrix's right/up columns
      // come out as the camera's right/up; the +Z column points back at
      // the origin (Object3D.lookAt's non-camera path swaps eye/target),
      // so negate to get the camera's looking direction.
      tempObj.position.copy(dirFromAzAlt(c.photoAz, c.photoTilt)).normalize();
      tempObj.lookAt(0, 0, 0);
      if (c.photoRoll !== 0) tempObj.rotateZ(c.photoRoll);
      tempObj.updateMatrixWorld();
      tempObj.matrixWorld.extractBasis(right, up, fwd);
      fwd.negate();

      const hw = CONE_DEPTH_M * Math.tan(c.sizeRad / 2);
      const hh = hw / c.aspect;

      const bx = ax + fwd.x * CONE_DEPTH_M;
      const by = ay + fwd.y * CONE_DEPTH_M;
      const bz = az + fwd.z * CONE_DEPTH_M;

      // Base corners TR, TL, BL, BR — sign pattern (+r,+u), (−r,+u), (−r,−u), (+r,−u).
      const cx = [
        bx + right.x * hw + up.x * hh,
        bx - right.x * hw + up.x * hh,
        bx - right.x * hw - up.x * hh,
        bx + right.x * hw - up.x * hh,
      ];
      const cy = [
        by + right.y * hw + up.y * hh,
        by - right.y * hw + up.y * hh,
        by - right.y * hw - up.y * hh,
        by + right.y * hw - up.y * hh,
      ];
      const cz = [
        bz + right.z * hw + up.z * hh,
        bz - right.z * hw + up.z * hh,
        bz - right.z * hw - up.z * hh,
        bz + right.z * hw - up.z * hh,
      ];

      for (let k = 0; k < 4; k++) {
        positions[i++] = ax;
        positions[i++] = ay;
        positions[i++] = az;
        positions[i++] = cx[k]!;
        positions[i++] = cy[k]!;
        positions[i++] = cz[k]!;
      }
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        positions[i++] = cx[k]!;
        positions[i++] = cy[k]!;
        positions[i++] = cz[k]!;
        positions[i++] = cx[k2]!;
        positions[i++] = cy[k2]!;
        positions[i++] = cz[k2]!;
      }
    }
    group.add(makeOverlayLineSegments(positions, mat));
    requestRender();
  }

  return {
    update(camLoc, cameraHeight, cones) {
      if (camLoc === lastCamLoc && cameraHeight === lastCameraHeight && cones === lastCones) return;
      lastCamLoc = camLoc;
      lastCameraHeight = cameraHeight;
      lastCones = cones;
      rebuild();
    },
    setVisible(visible) {
      group.visible = visible;
      requestRender();
    },
  };
}
