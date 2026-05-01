// Modal opened from the photo-body right-click context menu. Picks an
// existing control point to attach the new image measurement to, or creates
// a fresh CP (description only — no map location yet) and attaches.

import * as THREE from 'three';
import { getElement } from './types.js';
import type { ControlPointView } from './types.js';

export interface ObservationModal {
  open(overlay: THREE.Group, u: number, v: number): void;
}

export interface CreateObservationModalOptions {
  getControlPoints: () => readonly ControlPointView[];
  onPickExisting: (overlay: THREE.Group, u: number, v: number, controlPointId: string) => void;
  onCreateAndObserve: (overlay: THREE.Group, u: number, v: number, description: string) => Promise<void>;
}

export function createObservationModal({
  getControlPoints, onPickExisting, onCreateAndObserve,
}: CreateObservationModalOptions): ObservationModal {
  const modalEl = getElement('observe-modal');
  const closeBtn = getElement<HTMLButtonElement>('observe-close');
  const cancelBtn = getElement<HTMLButtonElement>('observe-cancel');
  const createBtn = getElement<HTMLButtonElement>('observe-create');
  const descEl = getElement<HTMLInputElement>('observe-new-desc');
  const listEl = getElement('observe-cp-list');

  let pending: { overlay: THREE.Group; u: number; v: number } | null = null;

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
        if (!pending) return;
        const ctx = pending;
        close();
        onPickExisting(ctx.overlay, ctx.u, ctx.v, cp.id);
      });
      listEl.appendChild(row);
    }
  }

  function open(overlay: THREE.Group, u: number, v: number): void {
    pending = { overlay, u, v };
    descEl.value = '';
    createBtn.disabled = false;
    renderList();
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
    createBtn.disabled = true;
    onCreateAndObserve(ctx.overlay, ctx.u, ctx.v, description)
      .then(() => { close(); })
      .catch((err: unknown) => {
        console.error('create CP + observe failed:', err);
        createBtn.disabled = false;
      });
  });

  return { open };
}
