// Right-side HUD: opacity slider + photo-parameters for the selected photo.
// Opacity mutates live; the typed params are committed via Save so a single
// undo entry covers them.

import { getElement, overlayData } from './types.js';
import { SIZE_MAX, SIZE_MIN } from './overlay.js';
import type { OverlayManager } from './overlay.js';
import type { SyncManager } from './sync.js';
import { clamp, degToRad, radToDeg } from './mathx.js';
import { applyPhotoSnapshot, snapshotPhoto } from './undo.js';
import type { PhotoSnapshot, UndoManager } from './undo.js';
import type * as THREE from 'three';

export interface PhotoHud {
  refresh(): void;
}

export interface CreatePhotoHudOptions {
  overlays: OverlayManager;
  sync: SyncManager;
  undoManager?: UndoManager;
}

export function createPhotoHud(
  { overlays, sync, undoManager }: CreatePhotoHudOptions,
): PhotoHud {
  const panelEl = getElement('photo-hud-panel');
  const saveBtn = getElement<HTMLButtonElement>('photo-hud-save');
  const opacityEl = getElement<HTMLInputElement>('photo-hud-opacity');
  const azEl = getElement<HTMLInputElement>('photo-hud-az');
  const tiltEl = getElement<HTMLInputElement>('photo-hud-tilt');
  const rollEl = getElement<HTMLInputElement>('photo-hud-roll');
  const fovEl = getElement<HTMLInputElement>('photo-hud-fov');
  const aspectEl = getElement<HTMLInputElement>('photo-hud-aspect');
  const k1El = getElement<HTMLInputElement>('photo-hud-k1');
  const k2El = getElement<HTMLInputElement>('photo-hud-k2');
  const azLockEl = getElement<HTMLInputElement>('photo-hud-az-lock');
  const tiltLockEl = getElement<HTMLInputElement>('photo-hud-tilt-lock');
  const rollLockEl = getElement<HTMLInputElement>('photo-hud-roll-lock');
  const fovLockEl = getElement<HTMLInputElement>('photo-hud-fov-lock');
  const k1LockEl = getElement<HTMLInputElement>('photo-hud-k1-lock');
  const k2LockEl = getElement<HTMLInputElement>('photo-hud-k2-lock');

  let bound: THREE.Group | null = null;
  let beforeSnapshot: PhotoSnapshot | null = null;

  function populate(overlay: THREE.Group): void {
    const pose = overlays.photos.extractPose(overlay, null);
    const locks = overlays.photos.getLocks(overlay);
    opacityEl.value = String(Math.round(overlays.photos.getOpacity(overlay) * 100));
    azEl.value = radToDeg(pose.photoAz).toFixed(2);
    tiltEl.value = radToDeg(pose.photoTilt).toFixed(2);
    rollEl.value = radToDeg(pose.photoRoll).toFixed(2);
    fovEl.value = radToDeg(pose.sizeRad).toFixed(2);
    aspectEl.value = pose.aspect.toFixed(4);
    k1El.value = pose.k1.toFixed(4);
    k2El.value = pose.k2.toFixed(4);
    azLockEl.checked = locks.lockPhotoAz;
    tiltLockEl.checked = locks.lockPhotoTilt;
    rollLockEl.checked = locks.lockPhotoRoll;
    fovLockEl.checked = locks.lockSizeRad;
    k1LockEl.checked = locks.lockDistK1;
    k2LockEl.checked = locks.lockDistK2;
    saveBtn.disabled = false;
  }

  function refresh(): void {
    const overlay = overlays.photos.getSelected();
    if (overlay === bound) {
      // Same overlay: only sync the opacity slider (its source of truth
      // is the material). Leave typed inputs alone so concurrent
      // canvas-driven refreshes don't clobber what the user is typing.
      if (overlay) {
        const next = String(Math.round(overlays.photos.getOpacity(overlay) * 100));
        if (opacityEl.value !== next) opacityEl.value = next;
      }
      return;
    }
    bound = overlay;
    if (!overlay) {
      panelEl.hidden = true;
      beforeSnapshot = null;
      return;
    }
    beforeSnapshot = undoManager ? snapshotPhoto(overlays, overlayData(overlay).id) : null;
    populate(overlay);
    panelEl.hidden = false;
  }

  opacityEl.addEventListener('input', () => {
    if (!bound) return;
    overlays.photos.setSelectedOpacity(parseFloat(opacityEl.value) / 100);
  });

  function readNumber(el: HTMLInputElement): number | null {
    const n = parseFloat(el.value);
    return Number.isFinite(n) ? n : null;
  }

  saveBtn.addEventListener('click', () => {
    if (!bound) return;
    const overlay = bound;

    const azDeg = readNumber(azEl);
    const tiltDeg = readNumber(tiltEl);
    const rollDeg = readNumber(rollEl);
    const fovDeg = readNumber(fovEl);
    const k1 = readNumber(k1El);
    const k2 = readNumber(k2El);
    if (azDeg === null) { azEl.focus(); return; }
    if (tiltDeg === null) { tiltEl.focus(); return; }
    if (rollDeg === null) { rollEl.focus(); return; }
    if (fovDeg === null) { fovEl.focus(); return; }
    if (k1 === null) { k1El.focus(); return; }
    if (k2 === null) { k2El.focus(); return; }

    const data = overlayData(overlay);
    const photoId = data.id;
    const after: PhotoSnapshot = {
      photoAz: degToRad(azDeg),
      photoTilt: degToRad(tiltDeg),
      photoRoll: degToRad(rollDeg),
      sizeRad: clamp(degToRad(fovDeg), SIZE_MIN, SIZE_MAX),
      aspect: data.aspect,
      opacity: overlays.photos.getOpacity(overlay),
      distK1: k1,
      distK2: k2,
      locks: {
        lockPhotoAz: azLockEl.checked,
        lockPhotoTilt: tiltLockEl.checked,
        lockPhotoRoll: rollLockEl.checked,
        lockSizeRad: fovLockEl.checked,
        lockDistK1: k1LockEl.checked,
        lockDistK2: k2LockEl.checked,
      },
    };

    const recordedBefore = beforeSnapshot;
    saveBtn.disabled = true;
    applyPhotoSnapshot(overlays, sync, photoId, after).then(
      () => {
        if (undoManager && recordedBefore) {
          undoManager.record({
            kind: 'photo-pose', id: photoId, before: recordedBefore, after,
          });
        }
        // Only advance the baseline if the user hasn't navigated away
        // during the save; otherwise the new selection's snapshot stands.
        if (bound === overlay) beforeSnapshot = after;
        saveBtn.disabled = false;
      },
      (err: unknown) => {
        sync.reportError('update photo parameters', err);
        saveBtn.disabled = false;
      },
    );
  });

  return { refresh };
}
