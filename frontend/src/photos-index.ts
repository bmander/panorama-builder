import * as api from './api.js';
import { radToDeg } from './mathx.js';
import { getElement, makeListCell, stationHref, stationLabel } from './types.js';

const HEADERS = ['Station', 'az', 'tilt', 'roll', 'fov', 'k1', 'k2'] as const;

const fmtAng = (rad: number): string => `${radToDeg(rad).toFixed(2)}°`;
const fmtCoef = (v: number): string => v.toFixed(4);

function renderHeader(): HTMLElement {
  const li = document.createElement('li');
  li.className = 'header';
  for (const label of HEADERS) {
    const sp = document.createElement('span');
    sp.textContent = label;
    li.append(sp);
  }
  return li;
}

function renderRow(p: api.ApiPhoto, stationName: string | null): HTMLElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = stationHref(p.station_id);
  a.className = 'desc';
  a.textContent = stationLabel(p.station_id, stationName);
  li.append(
    a,
    makeListCell('col-az', fmtAng(p.photo_az), p.lock_photo_az),
    makeListCell('col-tilt', fmtAng(p.photo_tilt), p.lock_photo_tilt),
    makeListCell('col-roll', fmtAng(p.photo_roll), p.lock_photo_roll),
    makeListCell('col-fov', fmtAng(p.size_rad), p.lock_size_rad),
    makeListCell('col-k1', fmtCoef(p.dist_k1), p.lock_dist_k1),
    makeListCell('col-k2', fmtCoef(p.dist_k2), p.lock_dist_k2),
  );
  return li;
}

function renderList(
  photos: readonly api.ApiPhoto[],
  nameById: Map<string, string | null>,
): void {
  const list = getElement('list');
  list.replaceChildren();
  if (photos.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no photos yet';
    list.appendChild(empty);
    return;
  }
  const sorted = [...photos].sort((a, b) => {
    const an = stationLabel(a.station_id, nameById.get(a.station_id) ?? null);
    const bn = stationLabel(b.station_id, nameById.get(b.station_id) ?? null);
    const sc = an.toLowerCase().localeCompare(bn.toLowerCase());
    return sc !== 0 ? sc : a.created_at.localeCompare(b.created_at);
  });
  list.appendChild(renderHeader());
  for (const p of sorted) {
    list.appendChild(renderRow(p, nameById.get(p.station_id) ?? null));
  }
}

async function main(): Promise<void> {
  try {
    const [photos, stations] = await Promise.all([
      api.listPhotos(), api.listStations(),
    ]);
    const nameById = new Map(stations.map(s => [s.id, s.name]));
    renderList(photos, nameById);
  } catch (err) {
    console.error('list photos failed:', err);
    const list = getElement('list');
    list.replaceChildren();
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'failed to load — see console';
    list.appendChild(li);
  }
}

void main();
