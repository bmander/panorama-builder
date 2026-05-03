// Modal opened from the photo-body right-click context menu. Lets the user
// type exact pose values (in degrees) and toggle per-parameter solver locks
// that map to the API's lock_photo_* / lock_size_rad fields.

import * as THREE from 'three';
import { getElement, overlayData } from './types.js';
import type { PhotoLocks } from './types.js';
import * as api from './api.js';
import { SIZE_MAX, SIZE_MIN } from './overlay.js';
import type { OverlayManager } from './overlay.js';
import type { SyncManager } from './sync.js';

export interface PhotoParamsModal {
  open(overlay: THREE.Group): void;
}

export interface CreatePhotoParamsModalOptions {
  overlays: OverlayManager;
  sync: SyncManager;
}

const deg = THREE.MathUtils.radToDeg;
const rad = THREE.MathUtils.degToRad;

export function createPhotoParamsModal(
  { overlays, sync }: CreatePhotoParamsModalOptions,
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
  const azLockEl = getElement<HTMLInputElement>('photo-params-az-lock');
  const tiltLockEl = getElement<HTMLInputElement>('photo-params-tilt-lock');
  const rollLockEl = getElement<HTMLInputElement>('photo-params-roll-lock');
  const fovLockEl = getElement<HTMLInputElement>('photo-params-fov-lock');

  let pending: THREE.Group | null = null;

  function close(): void {
    modalEl.hidden = true;
    pending = null;
  }

  function open(overlay: THREE.Group): void {
    pending = overlay;
    const pose = overlays.extractPose(overlay, null);
    const locks = overlays.getPhotoLocks(overlay);
    azEl.value = deg(pose.photoAz).toFixed(2);
    tiltEl.value = deg(pose.photoTilt).toFixed(2);
    rollEl.value = deg(pose.photoRoll).toFixed(2);
    fovEl.value = deg(pose.sizeRad).toFixed(2);
    aspectEl.value = pose.aspect.toFixed(4);
    azLockEl.checked = locks.lockPhotoAz;
    tiltLockEl.checked = locks.lockPhotoTilt;
    rollLockEl.checked = locks.lockPhotoRoll;
    fovLockEl.checked = locks.lockSizeRad;
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
    if (azDeg === null) { azEl.focus(); return; }
    if (tiltDeg === null) { tiltEl.focus(); return; }
    if (rollDeg === null) { rollEl.focus(); return; }
    if (fovDeg === null) { fovEl.focus(); return; }

    const sizeRad = THREE.MathUtils.clamp(rad(fovDeg), SIZE_MIN, SIZE_MAX);
    const data = overlayData(overlay);
    const photoId = data.id;
    const aspect = data.aspect;
    const opacity = overlays.getOpacity(overlay);

    const locks: PhotoLocks = {
      lockPhotoAz: azLockEl.checked,
      lockPhotoTilt: tiltLockEl.checked,
      lockPhotoRoll: rollLockEl.checked,
      lockSizeRad: fovLockEl.checked,
    };

    const payload: api.PhotoPosePatch = {
      aspect,
      photo_az: rad(azDeg),
      photo_tilt: rad(tiltDeg),
      photo_roll: rad(rollDeg),
      size_rad: sizeRad,
      opacity,
      lock_photo_az: locks.lockPhotoAz,
      lock_photo_tilt: locks.lockPhotoTilt,
      lock_photo_roll: locks.lockPhotoRoll,
      lock_size_rad: locks.lockSizeRad,
    };

    saveBtn.disabled = true;
    api.updatePhoto(photoId, payload).then(
      () => {
        // Register the new pose with the diff-cache BEFORE mutating the scene
        // — applyPose's notify() schedules a flush whose diff would otherwise
        // see a delta and re-PUT.
        sync.registerPhoto(photoId, {
          aspect: payload.aspect,
          photo_az: payload.photo_az,
          photo_tilt: payload.photo_tilt,
          photo_roll: payload.photo_roll,
          size_rad: payload.size_rad,
          opacity,
        });
        overlays.withBatch(() => {
          overlays.applyPose(overlay, {
            photoAz: payload.photo_az,
            photoTilt: payload.photo_tilt,
            photoRoll: payload.photo_roll,
            sizeRad: payload.size_rad,
            aspect: payload.aspect,
            camLat: 0,
            camLng: 0,
          });
          overlays.setPhotoLocks(overlay, locks);
        });
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
