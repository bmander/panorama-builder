import * as api from './api.js';
import { cpHref, fmtCpLatLng, getElement } from './types.js';

function renderList(cps: readonly api.ApiControlPoint[]): void {
  const list = getElement('list');
  list.replaceChildren();
  if (cps.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no control points yet';
    list.appendChild(empty);
    return;
  }
  const sorted = [...cps].sort((a, b) =>
    (a.description || '').toLowerCase().localeCompare((b.description || '').toLowerCase()),
  );
  for (const cp of sorted) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = cpHref(cp.id);
    a.className = 'desc';
    a.textContent = cp.description || '(unnamed)';
    const meta = document.createElement('span');
    meta.className = 'meta';
    if (cp.est_lat === null || cp.est_lng === null) meta.classList.add('unlocated');
    meta.textContent = fmtCpLatLng(cp.est_lat, cp.est_lng);
    li.append(a, meta);
    list.appendChild(li);
  }
}

async function main(): Promise<void> {
  try {
    const cps = await api.listControlPoints();
    renderList(cps);
  } catch (err) {
    console.error('list control points failed:', err);
    const list = getElement('list');
    list.replaceChildren();
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'failed to load — see console';
    list.appendChild(li);
  }
}

void main();
