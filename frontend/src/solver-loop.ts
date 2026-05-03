// Wraps the pure pose solver in the station-specific re-entrancy guard and
// scene-graph extraction. Callers invoke runSolve() after any mutation that
// could change image-measurement residuals.
//
// Camera position is fixed at the user-asserted station location; the joint
// solver only refines per-photo orientation/size against the seeded CPs.

import * as THREE from 'three';
import { solveJointPose, autoLocalFreeParams } from './solver.js';
import { overlayData, poiData } from './types.js';
import type {
  ControlPointSeed, JointPhoto, LatLng, POIProjection,
} from './types.js';
import type { OverlayManager } from './overlay.js';

export interface SolverLoop {
  runSolve(): void;
}

export interface CreateSolverLoopOptions {
  overlays: OverlayManager;
  getCameraLocation: () => LatLng | null;
  isSolveRollEnabled: () => boolean;
}

export function createSolverLoop({
  overlays, getCameraLocation, isSolveRollEnabled,
}: CreateSolverLoopOptions): SolverLoop {
  let isSolving = false;

  function solveAllPhotos(): void {
    const camLoc = getCameraLocation();
    if (!camLoc) return;

    interface PhotoEntry { overlay: THREE.Group; photo: JointPhoto; }
    const cpById = new Map(overlays.getControlPoints().map(cp => [cp.id, cp]));
    const cpsWithImageObs = new Set<string>();
    const entries: PhotoEntry[] = [];
    for (const o of overlays.listOverlays() as THREE.Group[]) {
      const anchored: POIProjection[] = [];
      for (const p of overlayData(o).pois ?? []) {
        const pd = poiData(p);
        if (pd.controlPointId === null) continue;
        const cp = cpById.get(pd.controlPointId);
        if (cp?.estLat == null || cp.estLng == null) continue;
        anchored.push({ u: pd.uv.u, v: pd.uv.v, controlPointId: pd.controlPointId });
        cpsWithImageObs.add(pd.controlPointId);
      }
      if (anchored.length === 0) continue;
      entries.push({
        overlay: o,
        photo: {
          pose: overlays.extractPose(o, camLoc),
          pois: anchored,
          free: autoLocalFreeParams(anchored.length, isSolveRollEnabled()),
        },
      });
    }
    if (entries.length === 0) return;

    const controlPoints: ControlPointSeed[] = [...cpsWithImageObs].map(id => {
      const cp = cpById.get(id)!;
      return { id, lat: cp.estLat!, lng: cp.estLng! };
    });

    overlays.withBatch(() => {
      const result = solveJointPose({
        camLoc,
        photos: entries.map(e => e.photo),
        controlPoints,
      });
      entries.forEach((e, i) => { overlays.applyPose(e.overlay, result.photos[i]!.pose); });
      for (const cp of result.controlPoints) {
        overlays.setControlPointEst(cp.id, { lat: cp.lat, lng: cp.lng });
      }
    });
  }

  return {
    runSolve(): void {
      if (isSolving) return;
      isSolving = true;
      try { solveAllPhotos(); } finally { isSolving = false; }
    },
  };
}
