// 3D line segments that visualize hard CP-CP constraints in the world view.
// Constraints whose endpoints have no estimated 3D location are skipped.

import * as THREE from 'three';
import type { ControlPointView, CPConstraintView, LatLng } from './types.js';
import { controlPointVertex } from './camera-anchored.js';
import { subscribeCurvatureChange } from './curvature.js';
import {
  clearLineGroup, makeOverlayLine, makeOverlayLineMaterial,
  ndcDistToProjectedSegment,
} from './overlay-lines.js';

const LINE_COLOR = 0xffcc33;
const LINE_COLOR_SELECTED = 0xff5544;
const LINE_COLOR_MULTI = 0x44ccff;

const EMPTY_MULTI: ReadonlySet<string> = new Set();

export interface CPConstraintLines {
  update(
    camLoc: LatLng | null,
    cameraMSL: number,
    cps: readonly ControlPointView[],
    constraints: readonly CPConstraintView[],
    selectedId: string | null,
    multiSelectedIds?: ReadonlySet<string>,
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
  const matMulti = makeOverlayLineMaterial(LINE_COLOR_MULTI);

  const lineGroup = new THREE.Group();
  scene.add(lineGroup);

  let drawn: DrawnConstraint[] = [];

  // Cached last-update args so a curvature toggle can rebuild without
  // waiting for the next data refresh from main.
  let lastCamLoc: LatLng | null = null;
  let lastCameraMSL = 0;
  let lastCps: readonly ControlPointView[] = [];
  let lastConstraints: readonly CPConstraintView[] = [];
  let lastSelectedId: string | null = null;
  let lastMultiSelectedIds: ReadonlySet<string> = EMPTY_MULTI;

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
      const va = controlPointVertex(a, lastCamLoc, lastCameraMSL);
      const vb = controlPointVertex(b, lastCamLoc, lastCameraMSL);
      if (!va || !vb) continue;
      const mat = k.id === lastSelectedId
        ? matSelected
        : lastMultiSelectedIds.has(k.id) ? matMulti : matDefault;
      lineGroup.add(makeOverlayLine([va.x, va.y, va.z, vb.x, vb.y, vb.z], mat));
      drawn.push({ id: k.id, a: va, b: vb });
    }
    requestRender();
  }

  subscribeCurvatureChange(rebuild);

  return {
    setVisible(visible) { lineGroup.visible = visible; },
    update(camLoc, cameraMSL, cps, constraints, selectedId, multiSelectedIds) {
      const multi = multiSelectedIds ?? EMPTY_MULTI;
      if (camLoc === lastCamLoc && cameraMSL === lastCameraMSL
        && cps === lastCps && constraints === lastConstraints
        && selectedId === lastSelectedId && multi === lastMultiSelectedIds) return;
      lastCamLoc = camLoc;
      lastCameraMSL = cameraMSL;
      lastCps = cps;
      lastConstraints = constraints;
      lastSelectedId = selectedId;
      lastMultiSelectedIds = multi;
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
