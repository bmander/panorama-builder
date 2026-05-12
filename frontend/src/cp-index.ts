import * as api from './api.js';
import { radToDeg } from './mathx.js';
import { cpHref, cpLabel, fmtAlt, fmtCpLatLng, getElement, makeListCell } from './types.js';

function fmtFit(rad: number): string {
  return `${radToDeg(rad).toFixed(3)}°`;
}

function renderList(
  cps: readonly api.ApiControlPoint[],
  fits: ReadonlyMap<string, api.ApiControlPointFit>,
): void {
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
    list.appendChild(renderRow(cp, fits.get(cp.id)));
  }
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
  const elev = makeListCell('col-elev', fmtAlt(cp.est_alt),
    cp.lock_est_alt, cp.est_alt === null);
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

async function main(): Promise<void> {
  try {
    const [cps, fits] = await Promise.all([
      api.listControlPoints(),
      api.listControlPointFits(),
    ]);
    const fitsByID = new Map(fits.control_points.map(f => [f.id, f]));
    renderList(cps, fitsByID);
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
