import * as api from './api.js';
import {
  appendSigma, appendSigmaMeters, fmtAlt, fmtCpLatLng, fmtSigmaMeters,
  getElement, makeListCell, sigmaSeverityClass, stationHref, stationLabel,
} from './types.js';
import {
  SIGMA_ALT_REFUSE_M, SIGMA_ALT_WARN_M,
  SIGMA_POS_REFUSE_M, SIGMA_POS_WARN_M,
} from './sigma-thresholds.js';

function renderRow(st: api.ApiStation): HTMLElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = stationHref(st.id);
  a.className = 'desc';
  a.textContent = stationLabel(st.id, st.name);
  const loc = makeListCell('col-loc', fmtCpLatLng(st.lat, st.lng),
    st.lock_lat && st.lock_lng);
  if (!st.lock_lat || !st.lock_lng) {
    appendSigmaMeters(loc, st.sigma_lat, st.sigma_lng,
      SIGMA_POS_WARN_M, SIGMA_POS_REFUSE_M,
      'σ from last solve (max of lat/lng, in meters)');
  }
  const elev = makeListCell('col-elev', fmtAlt(st.alt), st.lock_alt);
  if (!st.lock_alt) {
    appendSigma(elev,
      fmtSigmaMeters(st.sigma_alt ?? null),
      sigmaSeverityClass(st.sigma_alt ?? null, SIGMA_ALT_WARN_M, SIGMA_ALT_REFUSE_M),
      'σ of alt from last solve');
  }
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
