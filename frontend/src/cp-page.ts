import * as api from './api.js';
import { formatLocalDateTime, getElement } from './types.js';

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

function attachInlineEditor<V, El extends EditorEl>(opts: InlineEditorOptions<V, El>): void {
  const { host, read, render, makeInput, parse, save,
    enter = 'enter', equal = Object.is, afterAttach } = opts;
  host.classList.add('editable');
  render(read());

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
}

function attachNameEditor(cp: api.ApiControlPoint, host: HTMLElement): void {
  host.title = 'Click to rename';
  attachInlineEditor<string, HTMLInputElement>({
    host,
    read: () => cp.description,
    render: (v) => { host.textContent = v || '(unnamed)'; },
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

function attachDeleteButton(cp: api.ApiControlPoint, obsCount: number): void {
  const btn = getElement<HTMLButtonElement>('delete');
  btn.disabled = false;
  btn.addEventListener('click', () => {
    const obsNote = obsCount === 0
      ? ''
      : `\n\nIts ${obsCount} observation${obsCount === 1 ? '' : 's'} will be unlinked but kept.`;
    const label = cp.description || '(unnamed)';
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

function renderEstimate(el: HTMLElement, text: string | null, placeholder: string): void {
  el.textContent = text ?? placeholder;
  if (text === null) el.classList.add('empty');
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

  attachNameEditor(cp, nameEl);
  attachNotesEditor(cp, getElement('notes'));
  attachDateEditor(cp, getElement('started_at'), 'started_at');
  attachDateEditor(cp, getElement('ended_at'), 'ended_at');

  renderEstimate(locEl,
    cp.est_lat !== null && cp.est_lng !== null
      ? `${cp.est_lat.toFixed(6)}, ${cp.est_lng.toFixed(6)}`
      : null, 'no estimate');
  renderEstimate(altEl, cp.est_alt !== null ? `${cp.est_alt.toFixed(1)} m` : null, '—');

  let obsCount = 0;
  if (obsResult.status === 'fulfilled') {
    renderObservations(obsResult.value);
    obsCount = obsResult.value.image_measurements.length
      + obsResult.value.map_measurements.length;
  } else {
    console.error('observations fetch failed:', obsResult.reason);
  }
  attachDeleteButton(cp, obsCount);
}

void main();
