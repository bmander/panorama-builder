// Photo-pose snapshot helpers shared by the selected-photo HUD's save flow.
//
// Undo/redo itself is now session-global and server-backed (see
// session-undo.ts + the backend checkpoint stack); these helpers remain only
// as the mutation surface the HUD uses to apply a full pose at once.

import * as api from './api.js';
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
  readonly distK1: number;
  readonly distK2: number;
  readonly locks: PhotoLocks;
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
    distK1: pose.k1,
    distK2: pose.k2,
    locks: overlays.photos.getLocks(o),
  };
}

// Apply a full photo-pose snapshot via the standard API + sync + overlay
// pipeline. PUT first, pre-register with sync so the diff-driven flush
// triggered by applyPose's notify() sees no delta and doesn't re-PUT, then
// mutate the scene.
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
    dist_k1: snap.distK1,
    dist_k2: snap.distK2,
    lock_dist_k1: snap.locks.lockDistK1,
    lock_dist_k2: snap.locks.lockDistK2,
  };
  return api.updatePhoto(id, patch).then(() => {
    sync.registerPhoto(id, {
      aspect: snap.aspect,
      photo_az: snap.photoAz,
      photo_tilt: snap.photoTilt,
      photo_roll: snap.photoRoll,
      size_rad: snap.sizeRad,
      opacity: snap.opacity,
      dist_k1: snap.distK1,
      dist_k2: snap.distK2,
    });
    overlays.withBatch(() => {
      overlays.photos.applyPose(o, {
        photoAz: snap.photoAz, photoTilt: snap.photoTilt,
        photoRoll: snap.photoRoll, sizeRad: snap.sizeRad,
        aspect: snap.aspect, camLat: 0, camLng: 0,
        k1: snap.distK1, k2: snap.distK2,
      });
      overlays.photos.setLocks(o, snap.locks);
      overlays.photos.setOpacity(o, snap.opacity);
    });
  });
}
