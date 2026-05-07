// Modal opened from the photo-body right-click context menu. Lets the user
// type exact pose values (in degrees) and toggle per-parameter solver locks
// that map to the API's lock_photo_* / lock_size_rad fields.

import type * as THREE from 'three';
import { getElement, overlayData } from './types.js';
import { SIZE_MAX, SIZE_MIN } from './overlay.js';
import type { OverlayManager } from './overlay.js';
import type { SyncManager } from './sync.js';
import { clamp, degToRad, radToDeg } from './mathx.js';
import { applyPhotoSnapshot, snapshotPhoto } from './undo.js';
import type { PhotoSnapshot, UndoManager } from './undo.js';

export interface PhotoParamsModal {
  open(overlay: THREE.Group): void;
}

export interface CreatePhotoParamsModalOptions {
  overlays: OverlayManager;
  sync: SyncManager;
  undoManager?: UndoManager;
}

const deg = radToDeg;
const rad = degToRad;

export function createPhotoParamsModal(
  { overlays, sync, undoManager }: CreatePhotoParamsModalOptions,
): PhotoParamsModal {
  const modalEl = getElement('photo-params-modal');
  const closeBtn = getElement<HTMLButtonElement>('photo-params-close');
  const cancelBtn = getElement<HTMLButtonElement>('photo-params-cancel');
  const saveBtn = getElement<HTMLButtonElement>('photo-params-save');
  const azEl = getElement<HTMLInputElement>('photo-params-az');
  const tiltEl = getElement<HTMLInputElement>('photo-params-tilt');
  const rollEl = getElement<HTMLInputElement>('photo-params-roll');
  const fovEl = getElement<HTMLInputElement>('photo-params-fov');
  const aspectEl = getElement<HTMLInputElement>('photo-params-aspect');
  const k1El = getElement<HTMLInputElement>('photo-params-k1');
  const k2El = getElement<HTMLInputElement>('photo-params-k2');
  const azLockEl = getElement<HTMLInputElement>('photo-params-az-lock');
  const tiltLockEl = getElement<HTMLInputElement>('photo-params-tilt-lock');
  const rollLockEl = getElement<HTMLInputElement>('photo-params-roll-lock');
  const fovLockEl = getElement<HTMLInputElement>('photo-params-fov-lock');
  const k1LockEl = getElement<HTMLInputElement>('photo-params-k1-lock');
  const k2LockEl = getElement<HTMLInputElement>('photo-params-k2-lock');

  let pending: THREE.Group | null = null;
  let beforeSnapshot: PhotoSnapshot | null = null;

  function close(): void {
    modalEl.hidden = true;
    pending = null;
    beforeSnapshot = null;
  }

  function open(overlay: THREE.Group): void {
    pending = overlay;
    const pose = overlays.photos.extractPose(overlay, null);
    const locks = overlays.photos.getLocks(overlay);
    beforeSnapshot = undoManager ? snapshotPhoto(overlays, overlayData(overlay).id) : null;
    azEl.value = deg(pose.photoAz).toFixed(2);
    tiltEl.value = deg(pose.photoTilt).toFixed(2);
    rollEl.value = deg(pose.photoRoll).toFixed(2);
    fovEl.value = deg(pose.sizeRad).toFixed(2);
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
    modalEl.hidden = false;
    azEl.focus();
    azEl.select();
  }

  modalEl.addEventListener('click', e => {
    if (e.target === modalEl) close();
  });
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  function readNumber(el: HTMLInputElement): number | null {
    const n = parseFloat(el.value);
    return Number.isFinite(n) ? n : null;
  }

  saveBtn.addEventListener('click', () => {
    if (!pending) return;
    const overlay = pending;

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
      photoAz: rad(azDeg),
      photoTilt: rad(tiltDeg),
      photoRoll: rad(rollDeg),
      sizeRad: clamp(rad(fovDeg), SIZE_MIN, SIZE_MAX),
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

    saveBtn.disabled = true;
    applyPhotoSnapshot(overlays, sync, photoId, after).then(
      () => {
        if (undoManager && beforeSnapshot) {
          undoManager.record({
            kind: 'photo-pose', id: photoId, before: beforeSnapshot, after,
          });
        }
        close();
      },
      (err: unknown) => {
        sync.reportError('update photo parameters', err);
        saveBtn.disabled = false;
      },
    );
  });

  return { open };
}
