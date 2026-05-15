import * as api from './api.js';
import { radToDeg } from './mathx.js';
import {
  appendSigma, fmtSigmaRad, getElement, makeListCell,
  sigmaSeverityClass, stationHref, stationLabel,
} from './types.js';

// σ thresholds for the per-axis color stripe. Matches backend merge gate
// defaults; tune both together if you change them.
const SIGMA_ANGLE_WARN_RAD = 0.5 * Math.PI / 180;   // 0.5°
const SIGMA_ANGLE_REFUSE_RAD = 2 * Math.PI / 180;   // 2°

const HEADERS = ['Station', 'obs', 'az', 'tilt', 'roll', 'fov', 'k1', 'k2'] as const;

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

function renderRow(
  p: api.ApiPhoto, observationCount: number, stationName: string | null,
): HTMLElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = stationHref(p.station_id);
  a.className = 'desc';
  a.textContent = stationLabel(p.station_id, stationName);
  // Helper: add σ to a free angle cell only — locked axes have no σ to show.
  const angleCell = (
    cls: string, val: number, locked: boolean, sigma: number | null,
  ): HTMLElement => {
    const cell = makeListCell(cls, fmtAng(val), locked);
    if (!locked) {
      appendSigma(cell,
        fmtSigmaRad(sigma),
        sigmaSeverityClass(sigma, SIGMA_ANGLE_WARN_RAD, SIGMA_ANGLE_REFUSE_RAD),
        'σ from last solve');
    }
    return cell;
  };
  li.append(
    a,
    makeListCell('col-obs', String(observationCount), false),
    angleCell('col-az', p.photo_az, p.lock_photo_az, p.sigma_photo_az ?? null),
    angleCell('col-tilt', p.photo_tilt, p.lock_photo_tilt, p.sigma_photo_tilt ?? null),
    angleCell('col-roll', p.photo_roll, p.lock_photo_roll, p.sigma_photo_roll ?? null),
    angleCell('col-fov', p.size_rad, p.lock_size_rad, p.sigma_size_rad ?? null),
    makeListCell('col-k1', fmtCoef(p.dist_k1), p.lock_dist_k1),
    makeListCell('col-k2', fmtCoef(p.dist_k2), p.lock_dist_k2),
  );
  return li;
}

function renderList(
  items: readonly api.ApiPhotoListItem[],
  nameById: Map<string, string | null>,
): void {
  const list = getElement('list');
  list.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no photos yet';
    list.appendChild(empty);
    return;
  }
  const sorted = [...items].sort((a, b) => {
    const an = stationLabel(a.photo.station_id, nameById.get(a.photo.station_id) ?? null);
    const bn = stationLabel(b.photo.station_id, nameById.get(b.photo.station_id) ?? null);
    const sc = an.toLowerCase().localeCompare(bn.toLowerCase());
    return sc !== 0 ? sc : a.photo.created_at.localeCompare(b.photo.created_at);
  });
  list.appendChild(renderHeader());
  for (const item of sorted) {
    list.appendChild(renderRow(
      item.photo, item.observation_count,
      nameById.get(item.photo.station_id) ?? null,
    ));
  }
}

async function main(): Promise<void> {
  try {
    const [items, stations] = await Promise.all([
      api.listPhotos(), api.listStations(),
    ]);
    const nameById = new Map(stations.map(s => [s.id, s.name]));
    renderList(items, nameById);
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
