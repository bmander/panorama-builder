// Entry script for /cp/<id>. Reads the id from location.pathname, fetches
// the control point, and populates the page. Standalone — does not import
// the project-mode app shell (no viewer / overlay / sync scaffolding).

import * as api from './api.js';

const CP_ID_RE = /^\/cp\/([A-Z2-7]{13})$/;

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

async function main(): Promise<void> {
  const m = CP_ID_RE.exec(location.pathname);
  const nameEl = el('name');
  const idEl = el('id');
  const locEl = el('loc');
  const altEl = el('alt');

  if (!m) {
    nameEl.textContent = 'Bad URL';
    return;
  }
  const id = m[1]!;
  idEl.textContent = id;
  nameEl.textContent = 'Loading…';

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

void main();
