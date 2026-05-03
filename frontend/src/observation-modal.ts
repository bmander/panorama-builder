// Modal opened from the photo-body right-click context menu (image mode) or
// from the index-map right-click context menu (map mode). Image mode picks
// an existing CP to anchor a new image measurement to or creates a fresh CP
// + image measurement. Map mode is always "create CP at this lat/lng" — the
// modal also asks for an elevation above grade, which combines with the DEM
// ground elevation at the click to seed the CP's est_alt.

import * as THREE from 'three';
import { getElement } from './types.js';
import type { ControlPointView, LatLng } from './types.js';
import { getElevationAt } from './dem.js';

export interface ObservationModal {
  open(overlay: THREE.Group, u: number, v: number): void;
  openForMap(latlng: LatLng): void;
}

export interface CreateObservationModalOptions {
  getControlPoints: () => readonly ControlPointView[];
  onPickExisting: (overlay: THREE.Group, u: number, v: number, controlPointId: string) => void;
  onCreateAndObserve: (overlay: THREE.Group, u: number, v: number, description: string) => Promise<void>;
  onCreateMapAndObserve: (latlng: LatLng, description: string, estAlt: number | null) => Promise<void>;
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
  const elevRow = getElement('observe-elev-row');
  const elevInput = getElement<HTMLInputElement>('observe-new-elev');

  let pending: Pending | null = null;

  function close(): void {
    modalEl.hidden = true;
    pending = null;
    descEl.value = '';
    elevInput.value = '0';
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
    titleEl.textContent = 'Add observation';
    descLabelEl.textContent = 'Or create a new control point';
    descEl.value = '';
    elevInput.value = '0';
    createBtn.disabled = false;
    listEl.hidden = false;
    elevRow.hidden = true;
    renderList();
    modalEl.hidden = false;
    descEl.focus();
  }

  function openForMap(latlng: LatLng): void {
    pending = { kind: 'map', latlng };
    titleEl.textContent = 'Add control point';
    descLabelEl.textContent = 'Name';
    descEl.value = '';
    elevInput.value = '0';
    createBtn.disabled = false;
    // Map mode only creates a CP — no existing-CP picker, no observation row.
    listEl.hidden = true;
    listEl.replaceChildren();
    elevRow.hidden = false;
    modalEl.hidden = false;
    descEl.focus();
  }

  modalEl.addEventListener('click', e => {
    if (e.target === modalEl) close();
  });
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  async function submitMap(latlng: LatLng, description: string, aboveGrade: number): Promise<void> {
    const ground = await getElevationAt(latlng.lat, latlng.lng);
    const estAlt = ground === null ? null : ground + aboveGrade;
    await onCreateMapAndObserve(latlng, description, estAlt);
  }

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
      promise = onCreateAndObserve(ctx.overlay, ctx.u, ctx.v, description);
    } else {
      const aboveGrade = parseFloat(elevInput.value);
      if (!Number.isFinite(aboveGrade)) { elevInput.focus(); return; }
      promise = submitMap(ctx.latlng, description, aboveGrade);
    }
    createBtn.disabled = true;
    promise.then(() => { close(); })
      .catch((err: unknown) => {
        console.error('create CP + observe failed:', err);
        createBtn.disabled = false;
      });
  });

  return { open, openForMap };
}
