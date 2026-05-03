// Wraps the pure pose solver in the station-specific re-entrancy guard,
// scene-graph extraction, and camera-lock state. Callers invoke runSolve()
// after any mutation that could change anchored-POI residuals.

import * as THREE from 'three';
import { solveJointPose, autoLocalFreeParams } from './solver.js';
import { overlayData, poiData } from './types.js';
import type {
  ControlPointSeed, JointPhoto, LatLng, MapPrior, POIProjection, SolverParam,
} from './types.js';
import type { OverlayManager } from './overlay.js';

// One global σ in meters for every map prior. Roughly equivalent to ~1.7° of
// bearing slop at typical anchor distances; image bearings outvote the prior
// when they agree more strongly than that.
const MAP_PRIOR_SIGMA_M = 30;

export interface SolverLoop {
  runSolve(): void;
  setCameraLocked(locked: boolean): void;
}

export interface CreateSolverLoopOptions {
  overlays: OverlayManager;
  getCameraLocation: () => LatLng | null;
  isSolveRollEnabled: () => boolean;
  // Fired only when the joint solve actually moves the camera; the consumer
  // updates the cached station location and re-applies derived state.
  onCameraMovedBySolver: (loc: LatLng) => void;
}

export function createSolverLoop({
  overlays, getCameraLocation, isSolveRollEnabled, onCameraMovedBySolver,
}: CreateSolverLoopOptions): SolverLoop {
  const lockedParams = new Set<SolverParam>();
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

    // Priors only for CPs that also have image observations — a prior alone
    // has nothing to fight against and would just sit on the dot.
    const mapPriors: MapPrior[] = overlays.getMapMeasurements()
      .filter(m => m.controlPointId !== null && cpsWithImageObs.has(m.controlPointId))
      .map(m => ({
        cpId: m.controlPointId!, lat: m.latlng.lat, lng: m.latlng.lng,
        sigmaMeters: MAP_PRIOR_SIGMA_M,
      }));

    const cameraLocked = lockedParams.has('camLat') || lockedParams.has('camLng');

    const proposed: { camLoc: LatLng | null } = { camLoc: null };
    overlays.withBatch(() => {
      const result = solveJointPose({
        camLoc,
        photos: entries.map(e => e.photo),
        controlPoints,
        mapPriors,
        solveCamera: !cameraLocked,
      });
      entries.forEach((e, i) => { overlays.applyPose(e.overlay, result.photos[i]!.pose); });
      for (const cp of result.controlPoints) {
        overlays.setControlPointEst(cp.id, { lat: cp.lat, lng: cp.lng });
      }
      if (result.cameraMoved) proposed.camLoc = result.camLoc;
    });
    if (proposed.camLoc) onCameraMovedBySolver(proposed.camLoc);
  }

  return {
    runSolve(): void {
      if (isSolving) return;
      isSolving = true;
      try { solveAllPhotos(); } finally { isSolving = false; }
    },
    setCameraLocked(locked) {
      if (locked) { lockedParams.add('camLat'); lockedParams.add('camLng'); }
      else { lockedParams.delete('camLat'); lockedParams.delete('camLng'); }
    },
  };
}
