import * as api from './api.js';
import { cpLabel, formatLocalDateTime, getElement, indexCpHref, stationHref } from './types.js';

const CP_ID_RE = /^\/cp\/([A-Z2-7]{13})$/;

// Fields that the PUT SQL writes unconditionally. Patches must include them
// or they'll be cleared.
function cpPatch(cp: api.ApiControlPoint,
  override: Partial<api.ControlPointPatch>): api.ControlPointPatch {
  return {
    est_lat: cp.est_lat, est_lng: cp.est_lng, est_alt: cp.est_alt,
    started_at: cp.started_at, ended_at: cp.ended_at,
    ...override,
  };
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
}

// Returns a refresh() that re-runs render against the current read() — used
// when an external action (like a solve) mutates the underlying value.
function attachInlineEditor<V, El extends EditorEl>(opts: InlineEditorOptions<V, El>): () => void {
  const { host, read, render, makeInput, parse, save,
    enter = 'enter', equal = Object.is, afterAttach } = opts;
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
        () => { render(read()); },
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
      const updated = await api.updateControlPoint(cp.id, cpPatch(cp, { description: next }));
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
      const updated = await api.updateControlPoint(cp.id, cpPatch(cp, { notes: next }));
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
      const updated = await api.updateControlPoint(cp.id, cpPatch(cp, { [field]: next }));
      cp.est_lat = updated.est_lat;
      cp.est_lng = updated.est_lng;
      onAfterSave?.();
    },
    afterAttach: (el) => { host.classList.remove('empty'); el.select(); },
  });
}

function attachAltEditor(cp: api.ApiControlPoint, host: HTMLElement): () => void {
  host.title = 'Click to edit';
  const renderText = (v: number): void => {
    host.textContent = `${v.toFixed(1)} m`;
  };
  return attachInlineEditor<number, HTMLInputElement>({
    host,
    read: () => cp.est_alt,
    render: renderText,
    makeInput: (cur) => {
      const el = document.createElement('input');
      el.type = 'number';
      el.className = 'num-edit';
      el.step = 'any';
      el.value = String(cur);
      return el;
    },
    parse: (el) => {
      const n = parseFloat(el.value);
      return Number.isFinite(n) ? n : cp.est_alt;
    },
    save: async (next) => {
      const updated = await api.updateControlPoint(cp.id, cpPatch(cp, { est_alt: next }));
      cp.est_alt = updated.est_alt;
    },
    afterAttach: (el) => { el.select(); },
  });
}

type DateField = 'started_at' | 'ended_at';

function attachDateEditor(cp: api.ApiControlPoint, host: HTMLElement, field: DateField): void {
  host.title = 'Click to edit';
  const renderText = (v: string | null): void => {
    host.classList.toggle('empty', v === null);
    host.textContent = v === null ? 'click to set' : new Date(v).toLocaleString();
  };
  // Compare in user-visible form: datetime-local truncates seconds, so a stored
  // ISO with non-zero seconds would otherwise look "changed" on every blur.
  const visible = (v: string | null): string =>
    v === null ? '' : formatLocalDateTime(new Date(v));

  attachInlineEditor<string | null, HTMLInputElement>({
    host,
    read: () => cp[field],
    render: renderText,
    makeInput: (cur) => {
      const el = document.createElement('input');
      el.type = 'datetime-local';
      el.className = 'date-edit';
      el.step = '60';
      if (cur !== null) el.value = formatLocalDateTime(new Date(cur));
      return el;
    },
    parse: (el) => el.value === '' ? null : new Date(el.value).toISOString(),
    equal: (a, b) => visible(a) === visible(b),
    save: async (next) => {
      const updated = await api.updateControlPoint(cp.id, cpPatch(cp, { [field]: next }));
      cp.started_at = updated.started_at;
      cp.ended_at = updated.ended_at;
    },
    afterAttach: () => { host.classList.remove('empty'); },
  });
}

function attachSolveButton(
  cp: api.ApiControlPoint,
  obs: api.ApiControlPointObservations,
  onUpdate: (next: api.ApiControlPoint) => void,
): void {
  const btn = getElement<HTMLButtonElement>('solve');
  if (obs.image_measurements.length < 2) {
    btn.title = 'Need at least 2 image observations to refine';
    return;
  }
  btn.disabled = false;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    api.solveControlPoint(cp.id).then(
      result => {
        if (result.diverged) {
          alert('Solve made no progress — check the observations.');
          btn.disabled = false;
          return;
        }
        // Re-fetch the CP to pick up the persisted est_*; the response also
        // carries the diff but a fresh GET is the smallest amount of code.
        return api.getControlPoint(cp.id).then(updated => {
          onUpdate(updated);
          btn.disabled = false;
        });
      },
      (err: unknown) => {
        console.error('solve save failed:', err);
        alert('Solve failed — see console.');
        btn.disabled = false;
      },
    );
  });
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

function stationLabel(stationId: string, stationName: string | null): string {
  return stationName ?? `(untitled ${stationId.slice(0, 6)})`;
}

function appendObservationItem(
  list: HTMLElement, kind: 'map' | 'image', meta: Node,
): void {
  const li = document.createElement('li');
  const kindEl = document.createElement('span');
  kindEl.className = `kind ${kind}`;
  kindEl.textContent = kind;
  li.append(kindEl, meta);
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
  for (const m of obs.image_measurements) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    const a = document.createElement('a');
    a.href = stationHref(m.station_id, m.id);
    a.textContent = stationLabel(m.station_id, m.station_name);
    meta.append(`(u=${m.u.toFixed(2)}, v=${m.v.toFixed(2)}) in `, a);
    appendObservationItem(list, 'image', meta);
  }
}

type LockField = 'lock_est_lat' | 'lock_est_lng' | 'lock_est_alt';

function attachLockToggle(cp: api.ApiControlPoint, elId: string, field: LockField): void {
  const el = getElement<HTMLInputElement>(elId);
  el.checked = cp[field];
  el.addEventListener('change', () => {
    const next = el.checked;
    el.disabled = true;
    api.updateControlPoint(cp.id, cpPatch(cp, { [field]: next })).then(
      updated => { cp[field] = updated[field]; el.disabled = false; },
      (err: unknown) => {
        console.error('lock update failed:', err);
        el.checked = cp[field]; // revert
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

  const mapLinkEl = getElement<HTMLAnchorElement>('map-link');
  mapLinkEl.href = indexCpHref(cp.id);
  const refreshMapLink = (): void => {
    mapLinkEl.hidden = cp.est_lat === null || cp.est_lng === null;
  };
  refreshMapLink();

  attachNameEditor(cp, nameEl);
  attachNotesEditor(cp, getElement('notes'));
  const refreshLat = attachLatLngEditor(cp, latEl, 'est_lat', refreshMapLink);
  const refreshLng = attachLatLngEditor(cp, lngEl, 'est_lng', refreshMapLink);
  const refreshAlt = attachAltEditor(cp, altEl);
  attachDateEditor(cp, getElement('started_at'), 'started_at');
  attachDateEditor(cp, getElement('ended_at'), 'ended_at');
  attachLockToggle(cp, 'lock-est-lat', 'lock_est_lat');
  attachLockToggle(cp, 'lock-est-lng', 'lock_est_lng');
  attachLockToggle(cp, 'lock-est-alt', 'lock_est_alt');

  let obsCount = 0;
  if (obsResult.status === 'fulfilled') {
    const obs = obsResult.value;
    renderObservations(obs);
    obsCount = obs.image_measurements.length;
    attachSolveButton(cp, obs, updated => {
      cp.est_lat = updated.est_lat;
      cp.est_lng = updated.est_lng;
      cp.est_alt = updated.est_alt;
      refreshLat();
      refreshLng();
      refreshAlt();
      refreshMapLink();
    });
  } else {
    console.error('observations fetch failed:', obsResult.reason);
  }
  attachDeleteButton(cp, obsCount);
}

void main();
