import * as api from './api.js';
import { cpHref, cpLabel, fmtCpLatLng, getElement } from './types.js';

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
    a.textContent = cpLabel(cp.description);
    const meta = document.createElement('span');
    meta.className = 'meta';
    if (cp.est_lat === null || cp.est_lng === null) meta.classList.add('unlocated');
    meta.textContent = fmtCpLatLng(cp.est_lat, cp.est_lng);
    li.append(a, meta);
    const lockCount = +cp.lock_est_lat + +cp.lock_est_lng + +cp.lock_est_alt;
    if (lockCount > 0) {
      const lock = document.createElement('span');
      lock.className = lockCount === 3 ? 'locks full' : 'locks partial';
      lock.textContent = lockCount === 3 ? 'locked' : 'partial lock';
      li.append(lock);
    }
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
