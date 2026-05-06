// Modal opened from the photo-body right-click context menu (image mode) or
// from the index-map right-click context menu (map mode). Image mode picks
// an existing CP to anchor a new image measurement to or creates a fresh CP
// + image measurement. Map mode is always "create CP at this lat/lng"; the
// CP's elevation starts as null ("unknown") and is set later via the cp-page
// editor or by running the solver against image observations.

import * as THREE from 'three';
import { cpLabel, fmtCpLatLng, getElement } from './types.js';
import type { ControlPointView, LatLng } from './types.js';

export interface ObservationModal {
  open(overlay: THREE.Group, u: number, v: number): void;
  openForMap(latlng: LatLng): void;
}

export interface CreateObservationModalOptions {
  getControlPoints: () => readonly ControlPointView[];
  // Image-mode callbacks — only the station route opens with `open(...)`.
  onPickExisting?: (overlay: THREE.Group, u: number, v: number, controlPointId: string) => void;
  onCreateAndObserve?: (overlay: THREE.Group, u: number, v: number, description: string) => Promise<void>;
  // Map-mode callback — only the index route opens with `openForMap(...)`.
  onCreateMapAndObserve?: (latlng: LatLng, description: string) => Promise<void>;
}

type Pending =
  | { kind: 'image'; overlay: THREE.Group; u: number; v: number }
  | { kind: 'map'; latlng: LatLng };

export function createObservationModal({
  getControlPoints, onPickExisting, onCreateAndObserve, onCreateMapAndObserve,
}: CreateObservationModalOptions): ObservationModal {
  const modalEl = getElement('observe-modal');
  const titleEl = getElement('observe-title');
  const closeBtn = getElement<HTMLButtonElement>('observe-close');
  const cancelBtn = getElement<HTMLButtonElement>('observe-cancel');
  const createBtn = getElement<HTMLButtonElement>('observe-create');
  const descLabelEl = getElement('observe-desc-label');
  const descEl = getElement<HTMLInputElement>('observe-new-desc');
  const listEl = getElement('observe-cp-list');

  let pending: Pending | null = null;

  function close(): void {
    modalEl.hidden = true;
    pending = null;
    descEl.value = '';
    listEl.replaceChildren();
  }

  function renderList(): void {
    listEl.replaceChildren();
    const cps = getControlPoints();
    if (cps.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No control points yet — create one below.';
      listEl.appendChild(empty);
      return;
    }
    for (const cp of cps) {
      const row = document.createElement('div');
      row.className = 'cp-row';
      const desc = document.createElement('span');
      desc.className = 'desc';
      desc.textContent = cpLabel(cp.description);
      const meta = document.createElement('span');
      meta.className = 'meta';
      if (cp.estLat === null || cp.estLng === null) meta.classList.add('unlocated');
      meta.textContent = fmtCpLatLng(cp.estLat, cp.estLng);
      row.append(desc, meta);
      row.addEventListener('click', () => {
        if (pending?.kind !== 'image' || !onPickExisting) return;
        const ctx = pending;
        close();
        onPickExisting(ctx.overlay, ctx.u, ctx.v, cp.id);
      });
      listEl.appendChild(row);
    }
  }

  function open(overlay: THREE.Group, u: number, v: number): void {
    pending = { kind: 'image', overlay, u, v };
    titleEl.textContent = 'Add observation';
    descLabelEl.textContent = 'Or create a new control point';
    descEl.value = '';
    createBtn.disabled = false;
    listEl.hidden = false;
    renderList();
    modalEl.hidden = false;
    descEl.focus();
  }

  function openForMap(latlng: LatLng): void {
    pending = { kind: 'map', latlng };
    titleEl.textContent = 'Add control point';
    descLabelEl.textContent = 'Name';
    descEl.value = '';
    createBtn.disabled = false;
    // Map mode only creates a CP — no existing-CP picker, no observation row.
    listEl.hidden = true;
    listEl.replaceChildren();
    modalEl.hidden = false;
    descEl.focus();
  }

  modalEl.addEventListener('click', e => {
    if (e.target === modalEl) close();
  });
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  createBtn.addEventListener('click', () => {
    if (!pending) return;
    const ctx = pending;
    const description = descEl.value.trim();
    if (!description) {
      descEl.focus();
      return;
    }
    let promise: Promise<void>;
    if (ctx.kind === 'image') {
      if (!onCreateAndObserve) return;
      promise = onCreateAndObserve(ctx.overlay, ctx.u, ctx.v, description);
    } else {
      if (!onCreateMapAndObserve) return;
      promise = onCreateMapAndObserve(ctx.latlng, description);
    }
    createBtn.disabled = true;
    createBtn.classList.add('loading');
    promise.then(() => { close(); })
      .catch((err: unknown) => {
        console.error('create CP + observe failed:', err);
        createBtn.disabled = false;
      })
      .finally(() => { createBtn.classList.remove('loading'); });
  });

  return { open, openForMap };
}
