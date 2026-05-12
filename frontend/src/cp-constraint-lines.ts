// 3D line segments that visualize hard CP-CP constraints in the world view.
// Constraints whose endpoints have no estimated 3D location are skipped.

import * as THREE from 'three';
import type { ControlPointView, CPConstraintView, LatLng } from './types.js';
import { curvatureDrop, subscribeCurvatureChange } from './curvature.js';
import { latLngToCameraRelativeMeters } from './geo.js';
import {
  clearLineGroup, makeOverlayLine, makeOverlayLineMaterial,
  ndcDistToProjectedSegment,
} from './overlay-lines.js';

const LINE_COLOR = 0xffcc33;
const LINE_COLOR_SELECTED = 0xff5544;

export interface CPConstraintLines {
  update(
    camLoc: LatLng | null,
    cameraHeight: number,
    cps: readonly ControlPointView[],
    constraints: readonly CPConstraintView[],
    selectedId: string | null,
  ): void;
  findHit(
    ndc: { x: number; y: number },
    hitRadius: number,
    camera: THREE.Camera,
  ): { constraintId: string } | null;
  setVisible(visible: boolean): void;
}

export interface CreateCPConstraintLinesOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

interface DrawnConstraint {
  readonly id: string;
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
}

export function createCPConstraintLines(opts: CreateCPConstraintLinesOptions): CPConstraintLines {
  const { scene, requestRender } = opts;

  const matDefault = makeOverlayLineMaterial(LINE_COLOR);
  const matSelected = makeOverlayLineMaterial(LINE_COLOR_SELECTED);

  const lineGroup = new THREE.Group();
  scene.add(lineGroup);

  let drawn: DrawnConstraint[] = [];

  // Cached last-update args so a curvature toggle can rebuild without
  // waiting for the next data refresh from main.
  let lastCamLoc: LatLng | null = null;
  let lastCameraHeight = 0;
  let lastCps: readonly ControlPointView[] = [];
  let lastConstraints: readonly CPConstraintView[] = [];
  let lastSelectedId: string | null = null;

  function endpointFor(cp: ControlPointView, camLoc: LatLng, cameraHeight: number): THREE.Vector3 | null {
    if (cp.estLat === null || cp.estLng === null || cp.estAlt === null) return null;
    const { x, z } = latLngToCameraRelativeMeters({ lat: cp.estLat, lng: cp.estLng }, camLoc);
    const y = cp.estAlt - cameraHeight - curvatureDrop(x * x + z * z);
    return new THREE.Vector3(x, y, z);
  }

  function rebuild(): void {
    clearLineGroup(lineGroup);
    drawn = [];
    if (lastCamLoc === null) {
      requestRender();
      return;
    }
    const cpById = new Map<string, ControlPointView>(lastCps.map(cp => [cp.id, cp] as const));
    for (const k of lastConstraints) {
      const a = cpById.get(k.cpAId);
      const b = cpById.get(k.cpBId);
      if (!a || !b) continue;
      const va = endpointFor(a, lastCamLoc, lastCameraHeight);
      const vb = endpointFor(b, lastCamLoc, lastCameraHeight);
      if (!va || !vb) continue;
      const mat = k.id === lastSelectedId ? matSelected : matDefault;
      lineGroup.add(makeOverlayLine([va.x, va.y, va.z, vb.x, vb.y, vb.z], mat));
      drawn.push({ id: k.id, a: va, b: vb });
    }
    requestRender();
  }

  subscribeCurvatureChange(rebuild);

  return {
    setVisible(visible) { lineGroup.visible = visible; },
    update(camLoc, cameraHeight, cps, constraints, selectedId) {
      if (camLoc === lastCamLoc && cameraHeight === lastCameraHeight
        && cps === lastCps && constraints === lastConstraints
        && selectedId === lastSelectedId) return;
      lastCamLoc = camLoc;
      lastCameraHeight = cameraHeight;
      lastCps = cps;
      lastConstraints = constraints;
      lastSelectedId = selectedId;
      rebuild();
    },
    findHit(ndc, hitRadius, camera) {
      let bestDist = hitRadius;
      let best: { constraintId: string } | null = null;
      for (const d of drawn) {
        const dist = ndcDistToProjectedSegment(ndc, d.a, d.b, camera, true);
        if (dist < bestDist) {
          bestDist = dist;
          best = { constraintId: d.id };
        }
      }
      return best;
    },
  };
}
