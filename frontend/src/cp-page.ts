import * as api from './api.js';
import { degToRad } from './mathx.js';
import {
  appendSigmaMeters, appendSigmaScalar, cpLabel, fmtAlt, formatEstimateRange,
  formatImpreciseDate, formatLocalDateTime, getElement, indexCpHref,
  stationHref, stationLabel,
} from './types.js';
import {
  SIGMA_ALT_REFUSE_M, SIGMA_ALT_WARN_M,
  SIGMA_POS_REFUSE_M, SIGMA_POS_WARN_M,
} from './sigma-thresholds.js';

const CP_ID_RE = /^\/cp\/([A-Z2-7]{13})$/;

const CLIP_DEG = 2;
const CLIP_RAD = degToRad(CLIP_DEG);
const CLIP_SIZE_PX = 96;

function createObservationClip(m: api.ApiControlPointImageObservation): HTMLElement {
  const scaledW = CLIP_SIZE_PX * m.size_rad / CLIP_RAD;
  const scaledH = scaledW / m.aspect;
  const left = CLIP_SIZE_PX / 2 - m.u * scaledW;
  // v=1 is the top of the image (PlaneGeometry UV y=1 with flipY texture);
  // CSS top=0 is the top, so we use (1 - v) to translate into CSS y.
  const top = CLIP_SIZE_PX / 2 - (1 - m.v) * scaledH;
  const a = document.createElement('a');
  a.className = 'clip';
  a.href = stationHref(m.station_id, { focusImageId: m.id });
  const img = document.createElement('img');
  // Observations don't carry blob_path. The id-keyed fallback resolves
  // through `main`, which is fine — observations only exist post-merge.
  img.src = api.photoBlobUrl({ id: m.photo_id, blob_path: null });
  img.alt = '';
  img.draggable = false;
  img.loading = 'lazy';
  img.style.width = `${scaledW}px`;
  img.style.height = `${scaledH}px`;
  img.style.left = `${left}px`;
  img.style.top = `${top}px`;
  a.appendChild(img);
  return a;
}

type EditorEl = HTMLInputElement | HTMLTextAreaElement;

interface InlineEditorOptions<V, El extends EditorEl> {
  host: HTMLElement;
  read: () => V;
  render: (v: V) => void;
  makeInput: (current: V) => El;
  parse: (input: El) => V;
  save: (next: V) => Promise<void>;
  // 'enter' (default): plain Enter commits. 'modifier-enter': only Cmd/Ctrl+Enter
  // commits, leaving plain Enter to insert newlines (for textareas).
  enter?: 'enter' | 'modifier-enter';
  equal?: (a: V, b: V) => boolean;
  afterAttach?: (input: El) => void;
  // Lets sibling UI (e.g. the lifespan label) re-render off the same cp
  // object after a save commits.
  onValueChanged?: (() => void) | undefined;
}

// Returns a refresh() that re-runs render against the current read() — used
// when an external action (like a solve) mutates the underlying value.
function attachInlineEditor<V, El extends EditorEl>(opts: InlineEditorOptions<V, El>): () => void {
  const { host, read, render, makeInput, parse, save,
    enter = 'enter', equal = Object.is, afterAttach, onValueChanged } = opts;
  host.classList.add('editable');
  const refresh = (): void => { render(read()); };
  refresh();

  host.addEventListener('click', () => {
    if (host.querySelector('input, textarea')) return;
    const current = read();
    const input = makeInput(current);

    let settled = false;
    const restore = (): void => {
      if (settled) return;
      settled = true;
      render(read());
    };
    const commit = (): void => {
      if (settled) return;
      settled = true;
      const next = parse(input);
      if (equal(next, read())) {
        render(read());
        return;
      }
      input.disabled = true;
      save(next).then(
        () => { onValueChanged?.(); render(read()); },
        (err: unknown) => {
          console.error('inline-edit save failed:', err);
          render(read());
        },
      );
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); restore(); return; }
      if (e.key !== 'Enter') return;
      if (enter === 'modifier-enter' && !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      commit();
    };
    input.addEventListener('keydown', onKey as EventListener);
    input.addEventListener('blur', commit);

    host.replaceChildren(input);
    input.focus();
    afterAttach?.(input);
  });

  return refresh;
}

function attachNameEditor(cp: api.ApiControlPoint, host: HTMLElement): void {
  host.title = 'Click to rename';
  attachInlineEditor<string, HTMLInputElement>({
    host,
    read: () => cp.description,
    render: (v) => { host.textContent = cpLabel(v); },
    makeInput: (cur) => {
      const el = document.createElement('input');
      el.type = 'text';
      el.value = cur;
      el.className = 'name-edit';
      return el;
    },
    parse: (el) => el.value.trim(),
    save: async (next) => {
      const updated = await api.updateControlPoint(cp.id, { description: next });
      cp.description = updated.description;
    },
    afterAttach: (el) => { el.select(); },
  });
}

function attachNotesEditor(cp: api.ApiControlPoint, host: HTMLElement): void {
  host.title = 'Click to edit notes';
  const renderText = (v: string): void => {
    host.classList.toggle('empty', v === '');
    host.textContent = v === '' ? 'Click to add notes' : v;
  };
  attachInlineEditor<string, HTMLTextAreaElement>({
    host,
    read: () => cp.notes,
    render: renderText,
    makeInput: (cur) => {
      const el = document.createElement('textarea');
      el.value = cur;
      el.rows = Math.max(4, cur.split('\n').length + 1);
      return el;
    },
    parse: (el) => el.value,
    save: async (next) => {
      const updated = await api.updateControlPoint(cp.id, { notes: next });
      cp.notes = updated.notes;
    },
    enter: 'modifier-enter',
    afterAttach: (el) => {
      host.classList.remove('empty');
      el.setSelectionRange(el.value.length, el.value.length);
    },
  });
}

type LatLngField = 'est_lat' | 'est_lng';

function attachLatLngEditor(
  cp: api.ApiControlPoint, host: HTMLElement, field: LatLngField,
  onAfterSave?: () => void,
): () => void {
  const max = field === 'est_lat' ? 90 : 180;
  host.title = 'Click to edit';
  const renderText = (v: number | null): void => {
    host.classList.toggle('empty', v === null);
    host.textContent = v === null ? 'click to set' : v.toFixed(6);
  };
  return attachInlineEditor<number | null, HTMLInputElement>({
    host,
    read: () => cp[field],
    render: renderText,
    makeInput: (cur) => {
      const el = document.createElement('input');
      el.type = 'number';
      el.className = 'num-edit';
      el.step = 'any';
      el.min = String(-max);
      el.max = String(max);
      if (cur !== null) el.value = String(cur);
      return el;
    },
    parse: (el) => {
      if (el.value.trim() === '') return null;
      const n = parseFloat(el.value);
      return Number.isFinite(n) ? n : cp[field];
    },
    save: async (next) => {
      const updated = await api.updateControlPoint(cp.id, { [field]: next });
      cp.est_lat = updated.est_lat;
      cp.est_lng = updated.est_lng;
      onAfterSave?.();
    },
    afterAttach: (el) => { host.classList.remove('empty'); el.select(); },
  });
}

function attachAltEditor(cp: api.ApiControlPoint, host: HTMLElement): () => void {
  host.title = 'Click to edit';
  const renderText = (v: number | null): void => {
    host.classList.toggle('empty', v === null);
    host.textContent = v === null ? 'click to set' : fmtAlt(v);
  };
  return attachInlineEditor<number | null, HTMLInputElement>({
    host,
    read: () => cp.est_alt,
    render: renderText,
    makeInput: (cur) => {
      const el = document.createElement('input');
      el.type = 'number';
      el.className = 'num-edit';
      el.step = 'any';
      if (cur !== null) el.value = String(cur);
      return el;
    },
    parse: (el) => {
      if (el.value.trim() === '') return null;
      const n = parseFloat(el.value);
      return Number.isFinite(n) ? n : cp.est_alt;
    },
    save: async (next) => {
      const updated = await api.updateControlPoint(cp.id, { est_alt: next });
      cp.est_alt = updated.est_alt;
    },
    afterAttach: (el) => { host.classList.remove('empty'); el.select(); },
  });
}

type DateField = 'started_at' | 'ended_at';

const LENIENT_DATE_RE =
  /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?)?)?$/;

// Accepts a year alone, year-month, year-month-day, or any of those with an
// HH:MM or HH:MM:SS time appended via space or 'T'. Missing components default
// to the lowest valid value (Jan 1, 00:00:00). Returns an ISO string in local
// time, or null when the input doesn't match or rolls over (e.g. Feb 30).
function parseLenientDateTime(raw: string): string | null {
  const m = LENIENT_DATE_RE.exec(raw.trim());
  if (!m) return null;
  const yr = parseInt(m[1]!, 10);
  const mo = m[2] ? parseInt(m[2], 10) : 1;
  const dy = m[3] ? parseInt(m[3], 10) : 1;
  const hr = m[4] ? parseInt(m[4], 10) : 0;
  const mn = m[5] ? parseInt(m[5], 10) : 0;
  const sc = m[6] ? parseInt(m[6], 10) : 0;
  if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
  if (hr > 23 || mn > 59 || sc > 59) return null;
  const d = new Date(yr, mo - 1, dy, hr, mn, sc);
  if (d.getFullYear() !== yr || d.getMonth() !== mo - 1 || d.getDate() !== dy) return null;
  return d.toISOString();
}

function formatDerivedEstimate(cp: api.ApiControlPoint, field: DateField): string | null {
  const w = cp.derived_window;
  if (field === 'started_at') return formatEstimateRange(w.started_at_lower, w.started_at_upper);
  return formatEstimateRange(w.ended_at_lower, w.ended_at_upper);
}

function attachDateEditor(
  cp: api.ApiControlPoint, host: HTMLElement, field: DateField,
  onValueChanged?: () => void,
): void {
  host.title = 'Click to edit (e.g. 1886, 1886-06, 1886-06-15, 1886-06-15 14:30)';
  const renderText = (v: string | null): void => {
    if (v !== null) {
      host.classList.remove('empty');
      host.textContent = new Date(v).toLocaleString();
      return;
    }
    const est = formatDerivedEstimate(cp, field);
    host.classList.toggle('empty', est === null);
    host.textContent = est ?? 'click to set';
  };
  // Compare in user-visible (minute-precision local) form so a stored ISO
  // with non-zero seconds doesn't look "changed" on every blur.
  const visible = (v: string | null): string =>
    v === null ? '' : formatLocalDateTime(new Date(v));

  attachInlineEditor<string | null, HTMLInputElement>({
    host,
    read: () => cp[field],
    render: renderText,
    makeInput: (cur) => {
      const el = document.createElement('input');
      el.type = 'text';
      el.className = 'date-edit';
      el.placeholder = 'YYYY[-MM[-DD[ HH:MM]]]';
      if (cur !== null) el.value = formatLocalDateTime(new Date(cur));
      return el;
    },
    parse: (el) => {
      if (el.value.trim() === '') return null;
      // Bad input falls back to the read value so equal() short-circuits the save.
      return parseLenientDateTime(el.value) ?? cp[field];
    },
    equal: (a, b) => visible(a) === visible(b),
    save: async (next) => {
      const updated = await api.updateControlPoint(cp.id, { [field]: next });
      cp.started_at = updated.started_at;
      cp.ended_at = updated.ended_at;
    },
    afterAttach: (el) => { host.classList.remove('empty'); el.select(); },
    onValueChanged,
  });
}

function attachLifespanLabel(
  cp: api.ApiControlPoint, labelEl: HTMLElement, dateField: DateField,
): () => void {
  const verb = dateField === 'started_at' ? 'started' : 'ended';
  labelEl.title = `Set only when the exact ${verb} date is known. Otherwise leave blank — the derived window below shows what observations imply.`;
  const refresh = (): void => {
    labelEl.textContent = cp[dateField] === null ? verb : `${verb} at`;
  };
  refresh();
  return refresh;
}

function attachDeleteButton(cp: api.ApiControlPoint, obsCount: number): void {
  const btn = getElement<HTMLButtonElement>('delete');
  btn.disabled = false;
  btn.addEventListener('click', () => {
    const obsNote = obsCount === 0
      ? ''
      : `\n\nIts ${obsCount} observation${obsCount === 1 ? '' : 's'} will also be deleted.`;
    const label = cpLabel(cp.description);
    if (!confirm(`Delete ${label}?${obsNote}`)) return;
    btn.disabled = true;
    api.deleteControlPoint(cp.id).then(
      () => { location.assign('/'); },
      (err: unknown) => {
        console.error('delete failed:', err);
        alert('Delete failed — see console.');
        btn.disabled = false;
      },
    );
  });
}

function appendObservationItem(
  list: HTMLElement, meta: Node, leading?: Node,
): void {
  const li = document.createElement('li');
  if (leading) li.appendChild(leading);
  li.appendChild(meta);
  list.appendChild(li);
}

function renderObservations(obs: api.ApiControlPointObservations): void {
  const list = getElement('observations');
  list.replaceChildren();
  if (obs.image_measurements.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'no observations yet';
    list.appendChild(empty);
    return;
  }
  const measurements = [...obs.image_measurements].sort((a, b) => {
    const at = a.station_captured_at === null ? Infinity : Date.parse(a.station_captured_at);
    const bt = b.station_captured_at === null ? Infinity : Date.parse(b.station_captured_at);
    return at - bt;
  });
  for (const m of measurements) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    const a = document.createElement('a');
    a.href = stationHref(m.station_id, { focusImageId: m.id });
    a.textContent = stationLabel(m.station_id, m.station_name);
    const captured = document.createElement('span');
    captured.className = 'captured-at';
    captured.textContent = formatImpreciseDate(
      m.station_captured_at,
      m.station_derived_window.captured_at_lower,
      m.station_derived_window.captured_at_upper);
    meta.append(captured, ' in ', a);
    appendObservationItem(list, meta, createObservationClip(m));
  }
}

function renderVisiblePhotosEmpty(text: string): void {
  const list = getElement('visible-photos');
  list.replaceChildren();
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  list.appendChild(li);
}

// Human label for a per-station cp_observation, e.g. "marked missing" or
// "can't see — occluded". Returned text drives the badge in the candidate
// photos list so the user knows the photographer has already weighed in.
function cpObservationLabel(o: api.ApiCpObservation): string | null {
  if (o.status === 'missing') return 'marked missing';
  if (o.status === 'cant_see') {
    const r = o.reason;
    if (r === 'occluded') return "can't see — occluded";
    if (r === 'unclear')  return "can't see — unclear";
    return "can't see";
  }
  return null;
}

function renderVisiblePhotos(
  cp: api.ApiControlPoint,
  payload: api.ApiControlPointVisiblePhotos,
  observationsByStation: Map<string, api.ApiCpObservation>,
): void {
  if (cp.est_lat === null || cp.est_lng === null) {
    renderVisiblePhotosEmpty('Estimate a location to see candidate photos.');
    return;
  }
  if (payload.photos.length === 0) {
    renderVisiblePhotosEmpty('no candidate photos');
    return;
  }
  const list = getElement('visible-photos');
  list.replaceChildren();
  for (const p of payload.photos) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    const a = document.createElement('a');
    a.href = stationHref(p.station_id, { focusControlPointId: cp.id });
    a.textContent = stationLabel(p.station_id, p.station_name);
    const captured = document.createElement('span');
    captured.className = 'captured-at';
    captured.textContent = formatImpreciseDate(
      p.station_captured_at,
      p.station_derived_window.captured_at_lower,
      p.station_derived_window.captured_at_upper);
    meta.append(captured, ' in ', a);

    const obs = observationsByStation.get(p.station_id);
    const label = obs ? cpObservationLabel(obs) : null;
    if (obs && label !== null) {
      const status = document.createElement('span');
      status.className = `status ${obs.status}`;
      status.textContent = label;
      meta.append(' ', status);
    }
    appendObservationItem(list, meta);
  }
}

type LockField = 'lock_est_lat' | 'lock_est_lng' | 'lock_est_alt';

function attachLockToggle(cp: api.ApiControlPoint, elId: string, field: LockField): void {
  const el = getElement<HTMLInputElement>(elId);
  el.checked = cp[field];
  el.addEventListener('change', () => {
    const next = el.checked;
    el.disabled = true;
    api.updateControlPoint(cp.id, { [field]: next }).then(
      updated => { cp[field] = updated[field]; el.disabled = false; },
      (err: unknown) => {
        console.error('lock update failed:', err);
        el.checked = cp[field]; // revert
        el.disabled = false;
      },
    );
  });
}

function attachLocationLockToggle(cp: api.ApiControlPoint, elId: string): void {
  const el = getElement<HTMLInputElement>(elId);
  // Browser semantics: a click on an indeterminate checkbox commits to checked.
  const refresh = (): void => {
    const both = cp.lock_est_lat && cp.lock_est_lng;
    const neither = !cp.lock_est_lat && !cp.lock_est_lng;
    el.checked = both;
    el.indeterminate = !both && !neither;
  };
  refresh();
  el.addEventListener('change', () => {
    const next = el.checked;
    el.disabled = true;
    api.updateControlPoint(cp.id, { lock_est_lat: next, lock_est_lng: next }).then(
      updated => {
        cp.lock_est_lat = updated.lock_est_lat;
        cp.lock_est_lng = updated.lock_est_lng;
        refresh();
        el.disabled = false;
      },
      (err: unknown) => {
        console.error('lock update failed:', err);
        refresh();
        el.disabled = false;
      },
    );
  });
}

async function main(): Promise<void> {
  const m = CP_ID_RE.exec(location.pathname);
  const nameEl = getElement('name');
  const idEl = getElement('id');
  const latEl = getElement('lat');
  const lngEl = getElement('lng');
  const altEl = getElement('alt');

  if (!m) {
    nameEl.textContent = 'Bad URL';
    return;
  }
  const id = m[1]!;
  idEl.textContent = id;
  nameEl.textContent = 'Loading…';

  const [cpResult, obsResult, visResult, cpObsResult] = await Promise.allSettled([
    api.getControlPoint(id),
    api.listControlPointObservations(id),
    api.listControlPointVisiblePhotos(id),
    api.listCpObservationsByControlPoint(id),
  ]);

  if (cpResult.status === 'rejected') {
    console.error('control-point fetch failed:', cpResult.reason);
    nameEl.textContent = 'Not found';
    return;
  }
  const cp = cpResult.value;

  const mapLinkEl = getElement<HTMLAnchorElement>('map-link');
  mapLinkEl.href = indexCpHref(cp.id);
  const refreshMapLink = (): void => {
    mapLinkEl.hidden = cp.est_lat === null || cp.est_lng === null;
  };
  refreshMapLink();

  // cp_observation rows can only be created from the station page, so the
  // cp-page edits (lat/lng/date/notes) below never mutate them — fetched
  // once at load and reused on every refreshVisiblePhotos render.
  const observationsByStation = new Map<string, api.ApiCpObservation>();
  if (cpObsResult.status === 'fulfilled') {
    for (const o of cpObsResult.value) observationsByStation.set(o.station_id, o);
  } else {
    console.error('cp-observations fetch failed:', cpObsResult.reason);
  }

  // Many editor callbacks fire `refreshVisiblePhotos` and the user may edit
  // faster than the request round-trips; the seq counter prevents an earlier
  // slow response from overwriting a later one's render.
  let visSeq = 0;
  const refreshVisiblePhotos = (): void => {
    const my = ++visSeq;
    api.listControlPointVisiblePhotos(id).then(
      payload => { if (my === visSeq) renderVisiblePhotos(cp, payload, observationsByStation); },
      (err: unknown) => {
        if (my !== visSeq) return;
        console.error('visible-photos fetch failed:', err);
        renderVisiblePhotosEmpty('Failed to load candidate photos.');
      },
    );
  };
  const onLocationChanged = (): void => { refreshMapLink(); refreshVisiblePhotos(); };

  attachNameEditor(cp, nameEl);
  attachNotesEditor(cp, getElement('notes'));
  attachLatLngEditor(cp, latEl, 'est_lat', onLocationChanged);
  attachLatLngEditor(cp, lngEl, 'est_lng', onLocationChanged);
  attachAltEditor(cp, altEl);

  // σ is appended to the enclosing <dd> rather than the value span so
  // click-to-edit on the inputs doesn't replace it.
  appendSigmaMeters(latEl.parentElement!,
    cp.sigma_est_lat ?? null, cp.sigma_est_lng ?? null,
    SIGMA_POS_WARN_M, SIGMA_POS_REFUSE_M,
    'σ from last solve (max of lat/lng, in meters)');
  appendSigmaScalar(altEl.parentElement!,
    cp.sigma_est_alt ?? null,
    SIGMA_ALT_WARN_M, SIGMA_ALT_REFUSE_M,
    'σ of alt from last solve');
  const refreshStartedLabel = attachLifespanLabel(
    cp, getElement('started_at_label'), 'started_at');
  const refreshEndedLabel = attachLifespanLabel(
    cp, getElement('ended_at_label'), 'ended_at');
  attachDateEditor(cp, getElement('started_at'), 'started_at',
    () => { refreshStartedLabel(); refreshVisiblePhotos(); });
  attachDateEditor(cp, getElement('ended_at'), 'ended_at',
    () => { refreshEndedLabel(); refreshVisiblePhotos(); });
  attachLocationLockToggle(cp, 'lock-est-location');
  attachLockToggle(cp, 'lock-est-alt', 'lock_est_alt');

  if (visResult.status === 'fulfilled') {
    renderVisiblePhotos(cp, visResult.value, observationsByStation);
  } else {
    console.error('visible-photos fetch failed:', visResult.reason);
    renderVisiblePhotosEmpty('Failed to load candidate photos.');
  }

  let obsCount = 0;
  if (obsResult.status === 'fulfilled') {
    const obs = obsResult.value;
    renderObservations(obs);
    obsCount = obs.image_measurements.length;
  } else {
    console.error('observations fetch failed:', obsResult.reason);
  }
  attachDeleteButton(cp, obsCount);
}

void main();
