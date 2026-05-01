// Standalone view shown at /cp/<id> — fetches a single control point from
// the API and renders its description, location, and elevation. No editing
// affordances yet; this is read-only metadata.

import * as api from './api.js';
import { getElement } from './types.js';

export async function showControlPointDetail(id: string): Promise<void> {
  const view = getElement('cp-detail-view');
  // Hide everything else so the detail panel is alone on the page.
  for (const sel of ['#map-wrap', '#top-right', '#hud', '#save-error']) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) el.hidden = true;
  }
  const canvas = document.querySelector<HTMLCanvasElement>('canvas');
  if (canvas) canvas.style.display = 'none';
  view.hidden = false;

  const nameEl = getElement('cp-detail-name');
  const idEl = getElement('cp-detail-id');
  const locEl = getElement('cp-detail-loc');
  const altEl = getElement('cp-detail-alt');
  nameEl.textContent = 'Loading…';
  idEl.textContent = id;
  locEl.textContent = '';
  altEl.textContent = '';

  let cp: api.ApiControlPoint;
  try {
    cp = await api.getControlPoint(id);
  } catch (err) {
    console.error('control-point fetch failed:', err);
    nameEl.textContent = 'Not found';
    return;
  }

  nameEl.textContent = cp.description || '(unnamed)';
  if (cp.est_lat !== null && cp.est_lng !== null) {
    locEl.textContent = `${cp.est_lat.toFixed(6)}, ${cp.est_lng.toFixed(6)}`;
  } else {
    locEl.textContent = 'no estimate';
    locEl.classList.add('empty');
  }
  if (cp.est_alt !== null) {
    altEl.textContent = `${cp.est_alt.toFixed(1)} m`;
  } else {
    altEl.textContent = '—';
    altEl.classList.add('empty');
  }
}
