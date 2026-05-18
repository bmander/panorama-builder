// Session-local sundial picker: pick a control point as a gnomon, click on a
// CP surface where its shadow lands, see the implied sun direction and the
// date+time candidates that would produce it.
//
// All state is transient — nothing is persisted. The two picks live as long
// as the panel is open (and across re-opens within the same session).
//
// Shadow is stored as stable lat/lng/altitude (not camera-relative meters)
// so its rendered marker survives camera movement and so the sun-direction
// math is independent of the camera.

import { findSunDateTimeCandidates, type SunDateTimeCandidate } from './solar.js';
import { latLngToCameraRelativeMeters, vecToAzAlt } from './geo.js';
import { radToDeg, wrap2Pi } from './mathx.js';
import { attachDrag } from './dialog.js';
import { cpLabel, getElement, type ControlPointView, type LatLng } from './types.js';

export type SundialPickField = 'gnomon' | 'shadow';

export interface ShadowLocation {
  readonly latlng: LatLng;
  readonly altitude: number;
}

export interface SundialModal {
  open(): void;
  close(): void;
  // Wipe gnomon + shadow + picker state. Called on station swap so a stale
  // CP id from the previous station doesn't leak into the new one.
  reset(): void;
  onGnomonPicked(cpId: string): void;
  onShadowPicked(surfaceId: string, loc: ShadowLocation): void;
  // Current picks. The host polls these in its pose-update loop to drive
  // the marker dot and the gnomon → shadow connector line.
  getGnomonCpId(): string | null;
  getShadowLocation(): ShadowLocation | null;
}

export interface CreateSundialModalOptions {
  getControlPoint: (id: string) => ControlPointView | null;
  // Year used as the search window for the inverse. Pulled from the
  // station's captured_at (parsed as ISO) when available; the host falls
  // back to the current year if null.
  getCapturedAtYear: () => number | null;
  // Called when the user clicks one of the "Pick" buttons (field != null)
  // or when picking is cancelled (field == null). The host uses this to
  // route the next CP/surface click back to the panel instead of opening
  // the default context menu / delete modal.
  onPickStart: (field: SundialPickField | null) => void;
  // Notified whenever gnomon or shadow changes (picked, cleared, or reset).
  // The host re-pushes the shadow marker dot and the connector line.
  onPicksChange: () => void;
}

export function createSundialModal(opts: CreateSundialModalOptions): SundialModal {
  const panelEl = getElement('sundial-panel');
  const closeBtn = getElement<HTMLButtonElement>('sundial-close');
  const gnomonReadout = getElement('sundial-gnomon-readout');
  const shadowReadout = getElement('sundial-shadow-readout');
  const pickGnomonBtn = getElement<HTMLButtonElement>('sundial-pick-gnomon');
  const pickShadowBtn = getElement<HTMLButtonElement>('sundial-pick-shadow');
  const clearGnomonBtn = getElement<HTMLButtonElement>('sundial-clear-gnomon');
  const clearShadowBtn = getElement<HTMLButtonElement>('sundial-clear-shadow');
  const resultEl = getElement('sundial-result');
  attachDrag(panelEl.querySelector('.modal-header')!, panelEl);

  let gnomonCpId: string | null = null;
  let shadow: ShadowLocation | null = null;
  let pickingField: SundialPickField | null = null;

  function setPicking(field: SundialPickField | null): void {
    pickingField = field;
    pickGnomonBtn.classList.toggle('picking', field === 'gnomon');
    pickShadowBtn.classList.toggle('picking', field === 'shadow');
    opts.onPickStart(field);
  }

  function setShadow(loc: ShadowLocation | null): void {
    shadow = loc;
    opts.onPicksChange();
  }

  function setGnomon(cpId: string | null): void {
    gnomonCpId = cpId;
    opts.onPicksChange();
  }

  function close(): void {
    setPicking(null);
    panelEl.hidden = true;
  }
  function open(): void {
    refresh();
    panelEl.hidden = false;
  }

  function describeGnomon(): string {
    if (gnomonCpId === null) return 'not set';
    const cp = opts.getControlPoint(gnomonCpId);
    return cp ? cpLabel(cp.description) : gnomonCpId;
  }
  function describeShadow(): string {
    if (shadow === null) return 'not set';
    return `${shadow.latlng.lat.toFixed(6)}, ${shadow.latlng.lng.toFixed(6)} · ${shadow.altitude.toFixed(2)} m`;
  }

  // Explicit field options (not dateStyle/timeStyle) because Safari rejects
  // mixing those shortcuts with timeZoneName. The 'short' name tracks DST
  // per-date automatically — summer dates render PDT, winter dates PST.
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  function renderCandidates(candidates: SunDateTimeCandidate[]): string {
    if (candidates.length === 0) return '';
    const items = candidates.map(c => {
      const local = dateFormatter.format(c.date);
      const resDeg = radToDeg(c.residualRad).toFixed(2);
      return `<li>${local} <span class="muted">(residual ${resDeg}°)</span></li>`;
    }).join('');
    return `<ul class="sundial-candidates">${items}</ul>`;
  }

  function refresh(): void {
    gnomonReadout.textContent = describeGnomon();
    shadowReadout.textContent = describeShadow();
    clearGnomonBtn.hidden = gnomonCpId === null;
    clearShadowBtn.hidden = shadow === null;

    if (gnomonCpId === null || shadow === null) {
      resultEl.innerHTML = '<span class="muted">Pick a gnomon and a shadow point.</span>';
      return;
    }
    const cp = opts.getControlPoint(gnomonCpId);
    if (cp?.estLat == null || cp.estLng == null || cp.estAlt == null) {
      resultEl.innerHTML = '<span class="muted">Gnomon control point has no estimated 3D location.</span>';
      return;
    }
    // Compute the gnomon→shadow vector in the gnomon's local tangent frame.
    // east/south/up math is independent of the camera, so the result is
    // stable across camera movement.
    const gnomonLatLng: LatLng = { lat: cp.estLat, lng: cp.estLng };
    const shadowRel = latLngToCameraRelativeMeters(shadow.latlng, gnomonLatLng);
    const Sx = -shadowRel.x; // east component of (gnomon - shadow)
    const Sy = cp.estAlt - shadow.altitude;
    const Sz = -shadowRel.z; // south component
    const { az: viewerAz, alt } = vecToAzAlt(Sx, Sy, Sz);
    // vecToAzAlt returns CCW-from-north (viewer convention); solarAzAlt
    // expects CW-from-north (compass). Negate and wrap.
    const compassAz = wrap2Pi(-viewerAz);
    const azDeg = radToDeg(compassAz).toFixed(2);
    const altDeg = radToDeg(alt).toFixed(2);
    if (alt <= 0) {
      resultEl.innerHTML = `<div>Implied sun: az ${azDeg}° · alt ${altDeg}° (below horizon — check picks)</div>`;
      return;
    }
    const year = opts.getCapturedAtYear() ?? new Date().getFullYear();
    const candidates = findSunDateTimeCandidates(compassAz, alt, cp.estLat, cp.estLng, year);
    resultEl.innerHTML = `
      <div>Implied sun: az ${azDeg}° · alt ${altDeg}°</div>
      <div class="muted">Searching ${year} for matching dates…</div>
      ${renderCandidates(candidates)}
    `;
  }

  closeBtn.addEventListener('click', close);
  pickGnomonBtn.addEventListener('click', () => {
    setPicking(pickingField === 'gnomon' ? null : 'gnomon');
  });
  pickShadowBtn.addEventListener('click', () => {
    setPicking(pickingField === 'shadow' ? null : 'shadow');
  });
  clearGnomonBtn.addEventListener('click', () => { setGnomon(null); refresh(); });
  clearShadowBtn.addEventListener('click', () => { setShadow(null); refresh(); });

  function reset(): void {
    setPicking(null);
    gnomonCpId = null;
    shadow = null;
    opts.onPicksChange();
    panelEl.hidden = true;
  }

  return {
    open,
    close,
    reset,
    onGnomonPicked(cpId) {
      setGnomon(cpId);
      setPicking(null);
      refresh();
    },
    onShadowPicked(_surfaceId, loc) {
      setShadow(loc);
      setPicking(null);
      refresh();
    },
    getGnomonCpId: () => gnomonCpId,
    getShadowLocation: () => shadow,
  };
}
