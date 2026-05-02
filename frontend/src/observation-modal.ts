// Modal opened from the photo-body right-click context menu (image mode) or
// from the index-map right-click context menu (map mode). Picks an existing
// control point to attach the new observation to, or creates a fresh CP and
// attaches.
//
// Image mode is the original use case: the new observation is an image
// measurement on `(overlay, u, v)`. Map mode is for the index map: the new
// observation is a map measurement at `latlng`, and the existing-CP picker
// is hidden — the user is always creating a fresh CP at the click point.

import * as THREE from 'three';
import { getElement } from './types.js';
import type { ControlPointView, LatLng } from './types.js';

export interface ObservationModal {
  open(overlay: THREE.Group, u: number, v: number): void;
  openForMap(latlng: LatLng): void;
}

export interface CreateObservationModalOptions {
  getControlPoints: () => readonly ControlPointView[];
  onPickExisting: (overlay: THREE.Group, u: number, v: number, controlPointId: string) => void;
  onCreateAndObserve: (overlay: THREE.Group, u: number, v: number, description: string) => Promise<void>;
  onCreateMapAndObserve: (latlng: LatLng, description: string) => Promise<void>;
}

type Pending =
  | { kind: 'image'; overlay: THREE.Group; u: number; v: number }
  | { kind: 'map'; latlng: LatLng };

export function createObservationModal({
  getControlPoints, onPickExisting, onCreateAndObserve, onCreateMapAndObserve,
}: CreateObservationModalOptions): ObservationModal {
  const modalEl = getElement('observe-modal');
  const closeBtn = getElement<HTMLButtonElement>('observe-close');
  const cancelBtn = getElement<HTMLButtonElement>('observe-cancel');
  const createBtn = getElement<HTMLButtonElement>('observe-create');
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
      desc.textContent = cp.description || '(unnamed)';
      const meta = document.createElement('span');
      meta.className = 'meta';
      if (cp.estLat == null || cp.estLng == null) {
        meta.textContent = 'no location';
        meta.classList.add('unlocated');
      } else {
        meta.textContent = `${cp.estLat.toFixed(5)}, ${cp.estLng.toFixed(5)}`;
      }
      row.append(desc, meta);
      row.addEventListener('click', () => {
        if (pending?.kind !== 'image') return;
        const ctx = pending;
        close();
        onPickExisting(ctx.overlay, ctx.u, ctx.v, cp.id);
      });
      listEl.appendChild(row);
    }
  }

  function open(overlay: THREE.Group, u: number, v: number): void {
    pending = { kind: 'image', overlay, u, v };
    descEl.value = '';
    createBtn.disabled = false;
    listEl.hidden = false;
    renderList();
    modalEl.hidden = false;
    descEl.focus();
  }

  function openForMap(latlng: LatLng): void {
    pending = { kind: 'map', latlng };
    descEl.value = '';
    createBtn.disabled = false;
    // Per design: map mode only offers "create new" — the existing-CP list
    // doesn't make sense without an image observation to pair with.
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
    createBtn.disabled = true;
    const promise = ctx.kind === 'image'
      ? onCreateAndObserve(ctx.overlay, ctx.u, ctx.v, description)
      : onCreateMapAndObserve(ctx.latlng, description);
    promise.then(() => { close(); })
      .catch((err: unknown) => {
        console.error('create CP + observe failed:', err);
        createBtn.disabled = false;
      });
  });

  return { open, openForMap };
}
