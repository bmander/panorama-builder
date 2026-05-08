// Frustum pyramids for every other-station photo, drawn in the active
// station's photosphere. Cones at the selected station render in
// highlight color so the host can drive observation-ray rendering off
// the same selection.

import * as THREE from 'three';
import { latLngToCameraRelativeMeters } from './geo.js';
import { buildPoseObject } from './overlay-photos.js';
import { clearLineGroup, makeOverlayLineSegments } from './overlay-lines.js';
import type { LatLng } from './types.js';

const CONE_DEPTH_M = 4.0;
const CONE_COLOR = 0x80c0ff;
const CONE_COLOR_SELECTED = 0xffff66;

export interface StationCone {
  readonly stationId: string;
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
  update(
    camLoc: LatLng | null, cameraHeight: number,
    cones: readonly StationCone[], selectedStationId: string | null,
  ): void;
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
  const baseLineProps = {
    depthTest: false, depthWrite: false, transparent: true, fog: false,
  } as const;
  const mat = new THREE.LineBasicMaterial({ color: CONE_COLOR, ...baseLineProps });
  const matSel = new THREE.LineBasicMaterial({ color: CONE_COLOR_SELECTED, ...baseLineProps });

  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  let lastCamLoc: LatLng | null = null;
  let lastCameraHeight = 0;
  let lastCones: readonly StationCone[] = [];
  let lastSelectedStationId: string | null = null;

  function writeConeAt(out: Float32Array, base: number, c: StationCone, ax: number, ay: number, az: number): void {
    // buildPoseObject's matrix +Z points back at the origin (lookAt swap),
    // so negate fwd to get the camera's looking direction.
    buildPoseObject(c.photoAz, c.photoTilt, c.photoRoll).matrixWorld.extractBasis(right, up, fwd);
    fwd.negate();

    const hw = CONE_DEPTH_M * Math.tan(c.sizeRad / 2);
    const hh = hw / c.aspect;
    const bx = ax + fwd.x * CONE_DEPTH_M;
    const by = ay + fwd.y * CONE_DEPTH_M;
    const bz = az + fwd.z * CONE_DEPTH_M;

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

    let i = base;
    for (let k = 0; k < 4; k++) {
      out[i++] = ax; out[i++] = ay; out[i++] = az;
      out[i++] = cx[k]!; out[i++] = cy[k]!; out[i++] = cz[k]!;
    }
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      out[i++] = cx[k]!; out[i++] = cy[k]!; out[i++] = cz[k]!;
      out[i++] = cx[k2]!; out[i++] = cy[k2]!; out[i++] = cz[k2]!;
    }
  }

  function rebuild(): void {
    clearLineGroup(group);
    if (lastCamLoc === null || lastCones.length === 0) {
      requestRender();
      return;
    }
    let nDefault = 0;
    let nSelected = 0;
    for (const c of lastCones) {
      if (c.stationId === lastSelectedStationId) nSelected++;
      else nDefault++;
    }
    const defaultPositions = new Float32Array(nDefault * 48);
    const selectedPositions = new Float32Array(nSelected * 48);
    let dOff = 0;
    let sOff = 0;
    for (const c of lastCones) {
      const offset = latLngToCameraRelativeMeters({ lat: c.fromLat, lng: c.fromLng }, lastCamLoc);
      const ax = offset.x;
      const ay = c.fromAlt - lastCameraHeight;
      const az = offset.z;
      if (c.stationId === lastSelectedStationId) {
        writeConeAt(selectedPositions, sOff, c, ax, ay, az);
        sOff += 48;
      } else {
        writeConeAt(defaultPositions, dOff, c, ax, ay, az);
        dOff += 48;
      }
    }
    if (nDefault > 0) group.add(makeOverlayLineSegments(defaultPositions, mat));
    if (nSelected > 0) group.add(makeOverlayLineSegments(selectedPositions, matSel));
    requestRender();
  }

  return {
    update(camLoc, cameraHeight, cones, selectedStationId) {
      if (
        camLoc === lastCamLoc && cameraHeight === lastCameraHeight
        && cones === lastCones && selectedStationId === lastSelectedStationId
      ) return;
      lastCamLoc = camLoc;
      lastCameraHeight = cameraHeight;
      lastCones = cones;
      lastSelectedStationId = selectedStationId;
      rebuild();
    },
    setVisible(visible) {
      group.visible = visible;
      requestRender();
    },
  };
}
