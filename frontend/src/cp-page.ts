// Entry script for /cp/<id>. Reads the id from location.pathname, fetches
// the control point, and populates the page. Standalone — does not import
// the project-mode app shell (no viewer / overlay / sync scaffolding).

import * as api from './api.js';
import { getElement } from './types.js';

const CP_ID_RE = /^\/cp\/([A-Z2-7]{13})$/;

function projectLink(locationId: string, locationName: string | null): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = `/${locationId}`;
  a.textContent = locationName ?? `(untitled ${locationId.slice(0, 6)})`;
  return a;
}

type ObservationKind = 'map' | 'image';

function appendObservation(
  list: HTMLElement, kind: ObservationKind, metaText: string,
  locationId: string, locationName: string | null,
): void {
  const li = document.createElement('li');
  const kindEl = document.createElement('span');
  kindEl.className = `kind ${kind}`;
  kindEl.textContent = kind;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${metaText} in `;
  li.append(kindEl, meta, projectLink(locationId, locationName));
  list.appendChild(li);
}

function renderObservations(obs: api.ApiControlPointObservations): void {
  const list = getElement('observations');
  list.replaceChildren();
  if (obs.image_measurements.length === 0 && obs.map_measurements.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no observations yet';
    list.appendChild(empty);
    return;
  }
  for (const m of obs.map_measurements) {
    appendObservation(list, 'map', `${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`,
      m.location_id, m.location_name);
  }
  for (const m of obs.image_measurements) {
    appendObservation(list, 'image', `(u=${m.u.toFixed(2)}, v=${m.v.toFixed(2)})`,
      m.location_id, m.location_name);
  }
}

async function main(): Promise<void> {
  const m = CP_ID_RE.exec(location.pathname);
  const nameEl = getElement('name');
  const idEl = getElement('id');
  const locEl = getElement('loc');
  const altEl = getElement('alt');

  if (!m) {
    nameEl.textContent = 'Bad URL';
    return;
  }
  const id = m[1]!;
  idEl.textContent = id;
  nameEl.textContent = 'Loading…';

  const [cpResult, obsResult] = await Promise.allSettled([
    api.getControlPoint(id),
    api.listControlPointObservations(id),
  ]);

  if (cpResult.status === 'rejected') {
    console.error('control-point fetch failed:', cpResult.reason);
    nameEl.textContent = 'Not found';
    return;
  }
  const cp = cpResult.value;

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

  if (obsResult.status === 'fulfilled') {
    renderObservations(obsResult.value);
  } else {
    console.error('observations fetch failed:', obsResult.reason);
  }
}

void main();
