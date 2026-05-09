// 3D line segments that visualize hard CP-CP constraints in the world view.
// Constraints whose endpoints have no estimated 3D location are skipped.

import * as THREE from 'three';
import type { ControlPointView, CPConstraintView, LatLng } from './types.js';
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

  function endpointFor(cp: ControlPointView, camLoc: LatLng, cameraHeight: number): THREE.Vector3 | null {
    if (cp.estLat === null || cp.estLng === null || cp.estAlt === null) return null;
    const { x, z } = latLngToCameraRelativeMeters({ lat: cp.estLat, lng: cp.estLng }, camLoc);
    return new THREE.Vector3(x, cp.estAlt - cameraHeight, z);
  }

  return {
    setVisible(visible) { lineGroup.visible = visible; },
    update(camLoc, cameraHeight, cps, constraints, selectedId) {
      clearLineGroup(lineGroup);
      drawn = [];
      if (camLoc === null) {
        requestRender();
        return;
      }
      const cpById = new Map<string, ControlPointView>(cps.map(cp => [cp.id, cp] as const));
      for (const k of constraints) {
        const a = cpById.get(k.cpAId);
        const b = cpById.get(k.cpBId);
        if (!a || !b) continue;
        const va = endpointFor(a, camLoc, cameraHeight);
        const vb = endpointFor(b, camLoc, cameraHeight);
        if (!va || !vb) continue;
        const mat = k.id === selectedId ? matSelected : matDefault;
        lineGroup.add(makeOverlayLine([va.x, va.y, va.z, vb.x, vb.y, vb.z], mat));
        drawn.push({ id: k.id, a: va, b: vb });
      }
      requestRender();
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
