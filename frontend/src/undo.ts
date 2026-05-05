// In-memory undo/redo stack for the photosphere viewer.
//
// Records "memento" snapshots at gesture-end (in input.ts) and modal-save
// (in photo-params-modal.ts). Each entry pairs a before-state and an
// after-state; undo restores the before, redo restores the after.
//
// Apply paths reuse the existing mutation surfaces:
//   - photo pose changes → applyPhotoSnapshot (api.updatePhoto +
//     sync.registerPhoto + applyPose/setPhotoLocks/setOpacity), shared
//     with the photo-parameters modal's save flow.
//   - POI moves → overlays.moveImageMeasurement; the diff-based sync
//     flush handles the PUT (same as a user-driven drag).
//
// Recording is explicit (callers invoke .record(...) at commit points),
// not by intercepting overlay mutations.

import * as api from './api.js';
import { poiData } from './types.js';
import type { PhotoLocks } from './types.js';
import type { OverlayManager } from './overlay.js';
import type { SyncManager } from './sync.js';

export interface PhotoSnapshot {
  readonly photoAz: number;
  readonly photoTilt: number;
  readonly photoRoll: number;
  readonly sizeRad: number;
  readonly aspect: number;
  readonly opacity: number;
  readonly locks: PhotoLocks;
}

export type UndoAction =
  | { readonly kind: 'photo-pose'; readonly id: string;
      readonly before: PhotoSnapshot; readonly after: PhotoSnapshot }
  | { readonly kind: 'poi-move'; readonly id: string;
      readonly before: { readonly u: number; readonly v: number };
      readonly after: { readonly u: number; readonly v: number } };

export interface UndoManager {
  record(action: UndoAction): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

export interface CreateUndoManagerOptions {
  overlays: OverlayManager;
  sync: SyncManager;
  reportError: (label: string, err: unknown) => void;
}

const STACK_CAP = 100;

// Photo-pose snapshots come back from extractPose without a fully-rounded
// shape; comparing two snapshots field-by-field detects no-op gestures.
function photoSnapshotsEqual(a: PhotoSnapshot, b: PhotoSnapshot): boolean {
  return a.photoAz === b.photoAz && a.photoTilt === b.photoTilt
    && a.photoRoll === b.photoRoll && a.sizeRad === b.sizeRad
    && a.aspect === b.aspect && a.opacity === b.opacity
    && a.locks.lockPhotoAz === b.locks.lockPhotoAz
    && a.locks.lockPhotoTilt === b.locks.lockPhotoTilt
    && a.locks.lockPhotoRoll === b.locks.lockPhotoRoll
    && a.locks.lockSizeRad === b.locks.lockSizeRad;
}

export function snapshotPhoto(overlays: OverlayManager, id: string): PhotoSnapshot | null {
  const o = overlays.photos.getById(id);
  if (!o) return null;
  const pose = overlays.photos.extractPose(o, null);
  return {
    photoAz: pose.photoAz,
    photoTilt: pose.photoTilt,
    photoRoll: pose.photoRoll,
    sizeRad: pose.sizeRad,
    aspect: pose.aspect,
    opacity: overlays.photos.getOpacity(o),
    locks: overlays.photos.getLocks(o),
  };
}

export function snapshotPoi(overlays: OverlayManager, id: string): { u: number; v: number } | null {
  const poi = overlays.measurements.getById(id);
  if (!poi) return null;
  const { u, v } = poiData(poi).uv;
  return { u, v };
}

// Apply a full photo-pose snapshot via the standard API + sync + overlay
// pipeline. PUT first, pre-register with sync so the diff-driven flush
// triggered by applyPose's notify() sees no delta and doesn't re-PUT, then
// mutate the scene. Shared by undo/redo and the photo-parameters modal.
export function applyPhotoSnapshot(
  overlays: OverlayManager, sync: SyncManager,
  id: string, snap: PhotoSnapshot,
): Promise<void> {
  const o = overlays.photos.getById(id);
  if (!o) return Promise.resolve();
  const patch: api.PhotoPosePatch = {
    aspect: snap.aspect,
    photo_az: snap.photoAz,
    photo_tilt: snap.photoTilt,
    photo_roll: snap.photoRoll,
    size_rad: snap.sizeRad,
    opacity: snap.opacity,
    lock_photo_az: snap.locks.lockPhotoAz,
    lock_photo_tilt: snap.locks.lockPhotoTilt,
    lock_photo_roll: snap.locks.lockPhotoRoll,
    lock_size_rad: snap.locks.lockSizeRad,
  };
  return api.updatePhoto(id, patch).then(() => {
    sync.registerPhoto(id, {
      aspect: snap.aspect,
      photo_az: snap.photoAz,
      photo_tilt: snap.photoTilt,
      photo_roll: snap.photoRoll,
      size_rad: snap.sizeRad,
      opacity: snap.opacity,
    });
    overlays.withBatch(() => {
      overlays.photos.applyPose(o, {
        photoAz: snap.photoAz, photoTilt: snap.photoTilt,
        photoRoll: snap.photoRoll, sizeRad: snap.sizeRad,
        aspect: snap.aspect, camLat: 0, camLng: 0,
      });
      overlays.photos.setLocks(o, snap.locks);
      overlays.photos.setOpacity(o, snap.opacity);
    });
  });
}

export function createUndoManager(
  { overlays, sync, reportError }: CreateUndoManagerOptions,
): UndoManager {
  const undoStack: UndoAction[] = [];
  const redoStack: UndoAction[] = [];

  function pushBounded(stack: UndoAction[], action: UndoAction): void {
    stack.push(action);
    if (stack.length > STACK_CAP) stack.shift();
  }

  function applyAction(action: UndoAction, direction: 'undo' | 'redo'): void {
    if (action.kind === 'photo-pose') {
      const snap = direction === 'undo' ? action.before : action.after;
      void applyPhotoSnapshot(overlays, sync, action.id, snap).catch((err: unknown) => {
        reportError(`${direction} photo edit`, err);
      });
      return;
    }
    const target = direction === 'undo' ? action.before : action.after;
    const poi = overlays.measurements.getById(action.id);
    if (poi) overlays.measurements.move(poi, target.u, target.v);
  }

  return {
    record(action) {
      if (action.kind === 'photo-pose'
          && photoSnapshotsEqual(action.before, action.after)) return;
      if (action.kind === 'poi-move'
          && action.before.u === action.after.u
          && action.before.v === action.after.v) return;
      pushBounded(undoStack, action);
      redoStack.length = 0;
    },
    undo() {
      const action = undoStack.pop();
      if (!action) return;
      applyAction(action, 'undo');
      pushBounded(redoStack, action);
    },
    redo() {
      const action = redoStack.pop();
      if (!action) return;
      applyAction(action, 'redo');
      pushBounded(undoStack, action);
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  };
}
