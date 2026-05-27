// Right-side HUD: opacity slider + photo parameters. Pose/lock fields commit
// on change (one commit = one undo entry). Opacity is a session-only display
// control (see settings.ts) — it drives the photo's material live and is not
// persisted to the server or recorded for undo.

import {
  createSigmaSpan, fmtSigmaRad, getElement, overlayData, sigmaSeverityClass,
  syncInputValue, updateSigma,
} from './types.js';
import { SIZE_MAX, SIZE_MIN } from './overlay.js';
import type { OverlayManager } from './overlay.js';
import type { SyncManager } from './sync.js';
import { clamp, degToRad, radToDeg } from './mathx.js';
import { applyPhotoSnapshot, snapshotPhoto } from './undo.js';
import type { PhotoSnapshot, UndoManager } from './undo.js';
import type { PhotoLocks } from './types.js';
import { AUTO_LOCK_THRESHOLDS, applyLockState } from './auto-lock.js';
import type { PhotoAutoLock } from './auto-lock.js';
import { bindDisabledToSession, sessionStore } from './session-store.js';
import { SIGMA_ANGLE_REFUSE_RAD, SIGMA_ANGLE_WARN_RAD } from './sigma-thresholds.js';
import type * as THREE from 'three';

export interface PhotoHud {
  refresh(): void;
}

export interface CreatePhotoHudOptions {
  overlays: OverlayManager;
  sync: SyncManager;
  undoManager?: UndoManager;
  // Polled on every populate() so the disabled affordance tracks
  // matched-obs changes without its own event channel.
  getPhotoAutoLock: (photoId: string) => PhotoAutoLock;
}

export function createPhotoHud(
  { overlays, sync, undoManager, getPhotoAutoLock }: CreatePhotoHudOptions,
): PhotoHud {
  const sectionEl = getElement('params-photo-section');
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

  // Lock checkboxes are owned by applyLockState (in refresh below) since
  // their disabled bit folds session state with the per-axis auto-lock flag.
  // Mixing bindDisabledToSession in would clobber the auto-lock bit on every
  // session toggle.
  const editableInputs = [opacityEl, azEl, tiltEl, rollEl, fovEl, aspectEl, k1El, k2El];
  for (const el of editableInputs) bindDisabledToSession(el);

  // K1/K2 σ is dimensionless; the angle threshold is the natural scale
  // (same convention as merge_gate.go).
  const azSigmaEl = createSigmaSpan(azEl);
  const tiltSigmaEl = createSigmaSpan(tiltEl);
  const rollSigmaEl = createSigmaSpan(rollEl);
  const fovSigmaEl = createSigmaSpan(fovEl);
  const k1SigmaEl = createSigmaSpan(k1El);
  const k2SigmaEl = createSigmaSpan(k2El);

  function setSigma(el: HTMLSpanElement, sigma: number | null, locked: boolean, label: string): void {
    el.hidden = locked;
    if (locked) return;
    updateSigma(el, fmtSigmaRad(sigma),
      sigmaSeverityClass(sigma, SIGMA_ANGLE_WARN_RAD, SIGMA_ANGLE_REFUSE_RAD),
      `σ of ${label} from last solve`);
  }

  let bound: THREE.Group | null = null;

  function populate(overlay: THREE.Group): void {
    const pose = overlays.photos.extractPose(overlay, null);
    const locks = overlays.photos.getLocks(overlay);
    const sigmas = overlays.photos.getSigmas(overlay);
    const auto = getPhotoAutoLock(overlayData(overlay).id);
    syncInputValue(opacityEl, String(Math.round(overlays.photos.getOpacity(overlay) * 100)));
    syncInputValue(azEl, radToDeg(pose.photoAz).toFixed(2));
    syncInputValue(tiltEl, radToDeg(pose.photoTilt).toFixed(2));
    syncInputValue(rollEl, radToDeg(pose.photoRoll).toFixed(2));
    syncInputValue(fovEl, radToDeg(pose.sizeRad).toFixed(2));
    syncInputValue(aspectEl, pose.aspect.toFixed(4));
    syncInputValue(k1El, pose.k1.toFixed(4));
    syncInputValue(k2El, pose.k2.toFixed(4));
    // σ is hidden whenever effective-locked since the solver couldn't refine that axis.
    const azEff = applyLockState(azLockEl, locks.lockPhotoAz, auto.photoAz, AUTO_LOCK_THRESHOLDS.photoAz);
    const tiltEff = applyLockState(tiltLockEl, locks.lockPhotoTilt, auto.photoTilt, AUTO_LOCK_THRESHOLDS.photoTilt);
    const rollEff = applyLockState(rollLockEl, locks.lockPhotoRoll, auto.photoRoll, AUTO_LOCK_THRESHOLDS.photoRoll);
    const fovEff = applyLockState(fovLockEl, locks.lockSizeRad, auto.sizeRad, AUTO_LOCK_THRESHOLDS.sizeRad);
    const k1Eff = applyLockState(k1LockEl, locks.lockDistK1, auto.distK1, AUTO_LOCK_THRESHOLDS.distK1);
    const k2Eff = applyLockState(k2LockEl, locks.lockDistK2, auto.distK2, AUTO_LOCK_THRESHOLDS.distK2);
    setSigma(azSigmaEl, sigmas.sigmaPhotoAz, azEff, 'azimuth');
    setSigma(tiltSigmaEl, sigmas.sigmaPhotoTilt, tiltEff, 'tilt');
    setSigma(rollSigmaEl, sigmas.sigmaPhotoRoll, rollEff, 'roll');
    setSigma(fovSigmaEl, sigmas.sigmaSizeRad, fovEff, 'FOV');
    setSigma(k1SigmaEl, sigmas.sigmaDistK1, k1Eff, 'k1');
    setSigma(k2SigmaEl, sigmas.sigmaDistK2, k2Eff, 'k2');
  }

  function refresh(): void {
    const overlay = overlays.photos.getSelected();
    const changed = overlay !== bound;
    bound = overlay;
    if (!overlay) {
      if (changed) sectionEl.hidden = true;
      return;
    }
    if (changed) sectionEl.hidden = false;
    populate(overlay);
  }

  // Re-run populate on session toggle so applyLockState gets a chance to
  // fold the new editingActive() state into each lock checkbox's disabled
  // bit. Without this, the lock checkboxes would keep their pre-toggle
  // disabled value until the user re-selected a photo.
  sessionStore.onChange(refresh);

  // onApplied fires after the PUT succeeds and is used by the per-field wire
  // helpers to force-write the canonical (e.g. clamped) value back into the
  // input element, bypassing populate's focus-check.
  function commit(
    buildAfter: (before: PhotoSnapshot) => PhotoSnapshot,
    onApplied?: (after: PhotoSnapshot) => void,
  ): void {
    if (!bound) return;
    const overlay = bound;
    const id = overlayData(overlay).id;
    const before = snapshotPhoto(overlays, id);
    if (!before) return;
    const after = buildAfter(before);
    applyPhotoSnapshot(overlays, sync, id, after).then(
      () => {
        if (undoManager) undoManager.record({ kind: 'photo-pose', id, before, after });
        if (bound === overlay) {
          populate(overlay);
          onApplied?.(after);
        }
      },
      (err: unknown) => { sync.reportError('update photo parameters', err); },
    );
  }

  function wireDegField(
    el: HTMLInputElement,
    set: (rad: number, before: PhotoSnapshot) => PhotoSnapshot,
    get: (snap: PhotoSnapshot) => number,
  ): void {
    el.addEventListener('change', () => {
      if (!bound) return;
      const n = parseFloat(el.value);
      const snap = snapshotPhoto(overlays, overlayData(bound).id);
      if (!Number.isFinite(n)) {
        if (snap) el.value = radToDeg(get(snap)).toFixed(2);
        return;
      }
      commit(before => set(degToRad(n), before), after => {
        el.value = radToDeg(get(after)).toFixed(2);
      });
    });
  }

  function wireRawField(
    el: HTMLInputElement,
    set: (val: number, before: PhotoSnapshot) => PhotoSnapshot,
    get: (snap: PhotoSnapshot) => number,
  ): void {
    el.addEventListener('change', () => {
      if (!bound) return;
      const n = parseFloat(el.value);
      if (!Number.isFinite(n)) {
        const snap = snapshotPhoto(overlays, overlayData(bound).id);
        if (snap) el.value = get(snap).toFixed(4);
        return;
      }
      commit(before => set(n, before), after => {
        el.value = get(after).toFixed(4);
      });
    });
  }

  function wireLock(el: HTMLInputElement, key: keyof PhotoLocks): void {
    el.addEventListener('change', () => {
      commit(before => ({ ...before, locks: { ...before.locks, [key]: el.checked } }));
    });
  }

  wireDegField(azEl, (rad, b) => ({ ...b, photoAz: rad }), s => s.photoAz);
  wireDegField(tiltEl, (rad, b) => ({ ...b, photoTilt: rad }), s => s.photoTilt);
  wireDegField(rollEl, (rad, b) => ({ ...b, photoRoll: rad }), s => s.photoRoll);
  wireDegField(fovEl, (rad, b) => ({ ...b, sizeRad: clamp(rad, SIZE_MIN, SIZE_MAX) }), s => s.sizeRad);
  wireRawField(k1El, (n, b) => ({ ...b, distK1: n }), s => s.distK1);
  wireRawField(k2El, (n, b) => ({ ...b, distK2: n }), s => s.distK2);

  wireLock(azLockEl, 'lockPhotoAz');
  wireLock(tiltLockEl, 'lockPhotoTilt');
  wireLock(rollLockEl, 'lockPhotoRoll');
  wireLock(fovLockEl, 'lockSizeRad');
  wireLock(k1LockEl, 'lockDistK1');
  wireLock(k2LockEl, 'lockDistK2');

  opacityEl.addEventListener('input', () => {
    if (!bound) return;
    overlays.photos.setSelectedOpacity(parseFloat(opacityEl.value) / 100);
  });

  return { refresh };
}
