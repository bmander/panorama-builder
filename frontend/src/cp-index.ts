import * as api from './api.js';
import { radToDeg } from './mathx.js';
import {
  appendSigma, appendSigmaMeters, cpHref, cpLabel, fmtAlt, fmtCpLatLng,
  fmtSigmaMeters, getElement, makeListCell, sigmaSeverityClass,
} from './types.js';
import {
  SIGMA_ALT_REFUSE_M, SIGMA_ALT_WARN_M,
  SIGMA_POS_REFUSE_M, SIGMA_POS_WARN_M,
} from './sigma-thresholds.js';

type SortKey = 'name' | 'loc' | 'elev' | 'fit' | 'obs';
type SortDir = 'asc' | 'desc';

const HEADERS: readonly { readonly key: SortKey; readonly label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'loc', label: 'Location' },
  { key: 'elev', label: 'Elevation' },
  { key: 'fit', label: 'Fit' },
  { key: 'obs', label: 'Obs' },
];

let sort: { key: SortKey; dir: SortDir } = { key: 'name', dir: 'asc' };
let cps: readonly api.ApiControlPoint[] = [];
let fitsByID: ReadonlyMap<string, api.ApiControlPointFit> = new Map();

const fmtFit = (rad: number): string => `${radToDeg(rad).toFixed(3)}°`;

function sortValue(cp: api.ApiControlPoint, key: SortKey): number | string | null {
  switch (key) {
    case 'name': return (cp.description || '').toLowerCase();
    case 'loc': return cp.est_lat;
    case 'elev': return cp.est_alt;
    case 'fit': return fitsByID.get(cp.id)?.fit_rms_rad ?? null;
    case 'obs': return fitsByID.get(cp.id)?.observation_count ?? null;
  }
}

function sortCps(): readonly api.ApiControlPoint[] {
  const decorated = cps.map(cp => ({ cp, k: sortValue(cp, sort.key) }));
  const sign = sort.dir === 'asc' ? 1 : -1;
  decorated.sort((a, b) => {
    // Missing values sort to the end regardless of direction.
    if (a.k === null) return b.k === null ? 0 : 1;
    if (b.k === null) return -1;
    const cmp = typeof a.k === 'string' ? a.k.localeCompare(b.k as string) : a.k - (b.k as number);
    return sign * cmp;
  });
  return decorated.map(d => d.cp);
}

function renderHeader(): HTMLElement {
  const li = document.createElement('li');
  li.className = 'header';
  for (const h of HEADERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hdr';
    if (h.key === sort.key) btn.classList.add('active');
    btn.textContent = h.label;
    if (h.key === sort.key) {
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = sort.dir === 'asc' ? ' ↑' : ' ↓';
      btn.append(arrow);
    }
    btn.addEventListener('click', () => {
      sort = sort.key === h.key
        ? { key: h.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key: h.key, dir: 'asc' };
      render();
    });
    li.append(btn);
  }
  return li;
}

function renderRow(cp: api.ApiControlPoint, fit: api.ApiControlPointFit | undefined): HTMLElement {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = cpHref(cp.id);
  a.className = 'desc';
  a.textContent = cpLabel(cp.description);
  const unlocated = cp.est_lat === null || cp.est_lng === null;
  const loc = makeListCell('col-loc', fmtCpLatLng(cp.est_lat, cp.est_lng),
    cp.lock_est_lat && cp.lock_est_lng, unlocated);
  if (!cp.lock_est_lat || !cp.lock_est_lng) {
    appendSigmaMeters(loc, cp.sigma_est_lat, cp.sigma_est_lng,
      SIGMA_POS_WARN_M, SIGMA_POS_REFUSE_M,
      'σ from last solve (max of est_lat/est_lng, in meters)');
  }
  const elev = makeListCell('col-elev', fmtAlt(cp.est_alt),
    cp.lock_est_alt, cp.est_alt === null);
  if (!cp.lock_est_alt && cp.est_alt !== null) {
    appendSigma(elev,
      fmtSigmaMeters(cp.sigma_est_alt ?? null),
      sigmaSeverityClass(cp.sigma_est_alt ?? null, SIGMA_ALT_WARN_M, SIGMA_ALT_REFUSE_M),
      'σ of est_alt from last solve');
  }
  const fitCell = makeListCell('col-fit', fit ? fmtFit(fit.fit_rms_rad) : '—',
    false, fit === undefined);
  const obsCell = makeListCell('col-obs', fit ? String(fit.observation_count) : '—',
    false, fit === undefined);
  if (fit) {
    fitCell.title = 'RMS angular residual';
    obsCell.title = 'observations';
  }
  li.append(a, loc, elev, fitCell, obsCell);
  return li;
}

function render(): void {
  const list = getElement('list');
  list.replaceChildren();
  if (cps.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no control points yet';
    list.appendChild(empty);
    return;
  }
  list.appendChild(renderHeader());
  for (const cp of sortCps()) {
    list.appendChild(renderRow(cp, fitsByID.get(cp.id)));
  }
}

async function main(): Promise<void> {
  try {
    const [c, f] = await Promise.all([
      api.listControlPoints(),
      api.listControlPointFits(),
    ]);
    cps = c;
    fitsByID = new Map(f.control_points.map(x => [x.id, x]));
    render();
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
