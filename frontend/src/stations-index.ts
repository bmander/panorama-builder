import * as api from './api.js';
import {
  fmtAlt, fmtCpLatLng, getElement, makeListCell, stationHref, stationLabel,
} from './types.js';

function renderRow(st: api.ApiStation): HTMLElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = stationHref(st.id);
  a.className = 'desc';
  a.textContent = stationLabel(st.id, st.name);
  const loc = makeListCell('col-loc', fmtCpLatLng(st.lat, st.lng),
    st.lock_lat && st.lock_lng);
  const elev = makeListCell('col-elev', fmtAlt(st.alt), st.lock_alt);
  li.append(a, loc, elev);
  return li;
}

function renderList(stations: readonly api.ApiStation[]): void {
  const list = getElement('list');
  list.replaceChildren();
  if (stations.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no stations yet';
    list.appendChild(empty);
    return;
  }
  const sorted = [...stations].sort((a, b) =>
    stationLabel(a.id, a.name).toLowerCase()
      .localeCompare(stationLabel(b.id, b.name).toLowerCase()),
  );
  for (const st of sorted) {
    list.appendChild(renderRow(st));
  }
}

async function main(): Promise<void> {
  try {
    const stations = await api.listStations();
    renderList(stations);
  } catch (err) {
    console.error('list stations failed:', err);
    const list = getElement('list');
    list.replaceChildren();
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'failed to load — see console';
    list.appendChild(li);
  }
}

void main();
