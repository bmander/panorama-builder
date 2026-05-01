// Wraps the pure pose solver in the project-specific re-entrancy guard,
// scene-graph extraction, and camera-lock state. Callers invoke runSolve()
// after any mutation that could change anchored-POI residuals.

import * as THREE from 'three';
import { solveJointPose, autoLocalFreeParams } from './solver.js';
import { overlayData, poiData } from './types.js';
import type { JointPhoto, LatLng, SolverParam } from './types.js';
import type { OverlayManager } from './overlay.js';

export interface SolverLoop {
  runSolve(): void;
  setCameraLocked(locked: boolean): void;
}

export interface CreateSolverLoopOptions {
  overlays: OverlayManager;
  getCameraLocation: () => LatLng | null;
  isSolveRollEnabled: () => boolean;
  // Bundles mapView.setLocation + applyCameraLocation. Fired only when the
  // joint solve actually moves the camera.
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
    const entries: PhotoEntry[] = [];
    for (const o of overlays.listOverlays() as THREE.Group[]) {
      const anchored = (overlayData(o).pois ?? []).filter(p => poiData(p).controlPointAnchor);
      if (anchored.length === 0) continue;
      entries.push({
        overlay: o,
        photo: {
          pose: overlays.extractPose(o, camLoc),
          pois: anchored.map(p => {
            const pd = poiData(p);
            const anchor = pd.controlPointAnchor!;
            return { u: pd.uv.u, v: pd.uv.v, anchorLat: anchor.lat, anchorLng: anchor.lng };
          }),
          free: autoLocalFreeParams(anchored.length, isSolveRollEnabled()),
        },
      });
    }
    if (entries.length === 0) return;

    const totalPois = entries.reduce((s, e) => s + e.photo.pois.length, 0);
    const localUnknowns = entries.reduce((s, e) => s + e.photo.free.length, 0);
    const cameraLocked = lockedParams.has('camLat') || lockedParams.has('camLng');
    const solveCamera = !cameraLocked && totalPois >= localUnknowns + 2;

    const proposed: { camLoc: LatLng | null } = { camLoc: null };
    overlays.withBatch(() => {
      const result = solveJointPose({
        camLoc,
        photos: entries.map(e => e.photo),
        solveCamera,
      });
      entries.forEach((e, i) => { overlays.applyPose(e.overlay, result.photos[i]!.pose); });
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
