// Station lat / lng / alt + per-axis solver locks.
//
// The right-side params panel exposes the station's stored lat/lng/alt and
// per-axis solver locks; captured-at lives in the settings panel. Joint mode
// requires ≥2 stations with both lat and lng locked to fix
// translation+rotation gauge. We treat "lock location" as an atomic toggle
// on both lat and lng (locking only one wouldn't fix gauge anyway). "lock
// elevation" gates lock_alt; today the solver always treats station alt as
// a fixed input, so this lock is no-op-equivalent but kept for UI symmetry
// and forward-compat.

import * as api from './api.js';
import {
  createInconsistencyDetails, createSigmaSpan, fmtSigmaMeters,
  formatEstimateRange, formatLocalDateTime, getElement,
  sigmaSeverityClass, syncInputChecked, syncInputValue,
  updateSigma, worstHorizontalSigma,
} from './types.js';
import type { LatLng } from './types.js';
import {
  SIGMA_ALT_REFUSE_M, SIGMA_ALT_WARN_M,
  SIGMA_POS_REFUSE_M, SIGMA_POS_WARN_M,
} from './sigma-thresholds.js';

export interface StationFields {
  name: string | null;
  lat: number; lng: number; alt: number;
  lockLat: boolean; lockLng: boolean; lockAlt: boolean;
  // ISO timestamp for when the photographer set up the camera at this
  // station, or null when the date is unknown. Backend stores nullable
  // TIMESTAMPTZ; the UI converts to/from datetime-local.
  capturedAt: string | null;
  // Materialized derived bounds from the propagation pass. Surfaced as
  // an "Est. X – Y" hint under the (empty) captured-at input.
  derivedLower: string | null;
  derivedUpper: string | null;
  derivationInconsistent: boolean;
}

export interface StationFieldsHandle {
  hydrate: (s: api.ApiStation) => void;
  // The fly-between animation needs the station's display name + altitude
  // before transitioning. Other cache fields (lat/lng/locks) are internal.
  getNameAndAlt: () => { name: string | null; alt: number } | null;
  getCapturedAt: () => string | null;
}

export interface CreateStationFieldsOptions {
  // Getter so a single mount can swap stations in place via loadStation —
  // the listeners attached below read the *current* station id at PUT
  // time, not the one captured at mount time.
  getCurrentStationId: () => string;
  // Fires after every hydrate. Consumer typically does:
  //   if (terrain.setCameraMSL(alt)) refreshControlPointColumns();
  onAltitudeChanged: (alt: number) => void;
  // Fires only when a server PUT round-trip returns lat/lng different from
  // the cached values. Consumer typically calls applyCameraLocation(loc).
  onLocationChanged: (loc: LatLng) => void;
}

const fieldDigits = (key: 'lat' | 'lng' | 'alt'): number => key === 'alt' ? 2 : 6;

export function createStationFields(opts: CreateStationFieldsOptions): StationFieldsHandle {
  const { getCurrentStationId, onAltitudeChanged, onLocationChanged } = opts;

  const latEl = getElement<HTMLInputElement>('station-lat');
  const lngEl = getElement<HTMLInputElement>('station-lng');
  const altEl = getElement<HTMLInputElement>('station-alt');
  const lockPosEl = getElement<HTMLInputElement>('station-lock-pos');
  const lockAltEl = getElement<HTMLInputElement>('station-lock-alt');
  const capturedAtEl = getElement<HTMLInputElement>('station-captured-at');
  const capturedAtEstEl = getElement<HTMLSpanElement>('station-captured-at-est');

  const sigmaPosEl = createSigmaSpan(lngEl.parentElement!);
  const sigmaAltEl = createSigmaSpan(altEl.parentElement!);

  function renderSigma(s: api.ApiStation): void {
    const posLocked = s.lock_lat && s.lock_lng;
    sigmaPosEl.hidden = posLocked;
    if (!posLocked) {
      const worst = worstHorizontalSigma(s.sigma_lat, s.sigma_lng);
      updateSigma(sigmaPosEl, fmtSigmaMeters(worst),
        sigmaSeverityClass(worst, SIGMA_POS_WARN_M, SIGMA_POS_REFUSE_M),
        'σ from last solve (max of lat/lng, in meters)');
    }
    sigmaAltEl.hidden = s.lock_alt;
    if (!s.lock_alt) {
      updateSigma(sigmaAltEl, fmtSigmaMeters(s.sigma_alt ?? null),
        sigmaSeverityClass(s.sigma_alt ?? null, SIGMA_ALT_WARN_M, SIGMA_ALT_REFUSE_M),
        'σ of alt from last solve');
    }
  }

  // Local mirror of the canonical station fields, populated by hydrate().
  // Used for rendering inputs and detecting no-op edits; the PUT itself only
  // carries the changed key, so this is a display cache, not a round-trip
  // shim.
  let cache: StationFields | null = null;

  function renderCapturedAt(): void {
    if (!cache) return;
    capturedAtEl.value = cache.capturedAt === null
      ? ''
      : formatLocalDateTime(new Date(cache.capturedAt));
    renderCapturedAtEstimate();
  }

  // Memoized so a hydrate from an unrelated PUT (lat/lng/etc) doesn't
  // collapse an expanded reasons list or trigger a refetch.
  let inconsistencyDetails: { stationId: string; el: HTMLDetailsElement } | null = null;

  function renderCapturedAtEstimate(): void {
    if (cache?.capturedAt !== null) {
      capturedAtEstEl.hidden = true;
      capturedAtEstEl.replaceChildren();
      return;
    }
    const est = formatEstimateRange(cache.derivedLower, cache.derivedUpper);
    if (est === null && !cache.derivationInconsistent) {
      capturedAtEstEl.hidden = true;
      capturedAtEstEl.replaceChildren();
      return;
    }
    capturedAtEstEl.hidden = false;
    const children: Node[] = [];
    if (est !== null) children.push(document.createTextNode(est + ' '));
    if (cache.derivationInconsistent) {
      const id = getCurrentStationId();
      if (inconsistencyDetails?.stationId !== id) {
        inconsistencyDetails = {
          stationId: id,
          el: createInconsistencyDetails(() => api.getStationInconsistencyReasons(id)),
        };
      }
      children.push(inconsistencyDetails.el);
    } else {
      inconsistencyDetails = null;
    }
    capturedAtEstEl.replaceChildren(...children);
  }

  function render(): void {
    if (!cache) return;
    syncInputValue(latEl, cache.lat.toFixed(fieldDigits('lat')));
    syncInputValue(lngEl, cache.lng.toFixed(fieldDigits('lng')));
    syncInputValue(altEl, cache.alt.toFixed(fieldDigits('alt')));
    if (document.activeElement !== capturedAtEl) renderCapturedAt();
    syncInputChecked(lockPosEl, cache.lockLat && cache.lockLng);
    syncInputChecked(lockAltEl, cache.lockAlt);
  }

  function hydrate(s: api.ApiStation): void {
    cache = {
      name: s.name,
      lat: s.lat, lng: s.lng, alt: s.alt,
      lockLat: s.lock_lat, lockLng: s.lock_lng, lockAlt: s.lock_alt,
      capturedAt: s.captured_at,
      derivedLower: s.derived_window.captured_at_lower,
      derivedUpper: s.derived_window.captured_at_upper,
      derivationInconsistent: s.derived_window.inconsistent,
    };
    onAltitudeChanged(s.alt);
    render();
    renderSigma(s);
  }

  async function putPatch(patch: Partial<StationFields>): Promise<void> {
    if (!cache) return;
    const body: api.StationUpdate = {};
    if (patch.lat !== undefined) body.lat = patch.lat;
    if (patch.lng !== undefined) body.lng = patch.lng;
    if (patch.alt !== undefined) body.alt = patch.alt;
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.lockLat !== undefined) body.lock_lat = patch.lockLat;
    if (patch.lockLng !== undefined) body.lock_lng = patch.lockLng;
    if (patch.lockAlt !== undefined) body.lock_alt = patch.lockAlt;
    if (patch.capturedAt !== undefined) body.captured_at = patch.capturedAt ?? null;
    let updated: api.ApiStation;
    try {
      updated = await api.updateStation(getCurrentStationId(), body);
    } catch (err) {
      console.error('update station failed:', err);
      render(); // revert UI to the last known-good cache
      return;
    }
    const locChanged = cache.lat !== updated.lat || cache.lng !== updated.lng;
    hydrate(updated);
    if (locChanged) onLocationChanged({ lat: updated.lat, lng: updated.lng });
  }

  function commitNumberInput(el: HTMLInputElement, key: 'lat' | 'lng' | 'alt'): void {
    const n = parseFloat(el.value);
    if (!Number.isFinite(n) || !cache) {
      render();
      return;
    }
    // Compare at the displayed precision — otherwise re-typing the rounded
    // value would silently truncate the server's higher-precision number.
    const digits = fieldDigits(key);
    if (cache[key].toFixed(digits) === n.toFixed(digits)) {
      render();
      return;
    }
    void putPatch({ [key]: n });
  }

  latEl.addEventListener('change', () => { commitNumberInput(latEl, 'lat'); });
  lngEl.addEventListener('change', () => { commitNumberInput(lngEl, 'lng'); });
  altEl.addEventListener('change', () => { commitNumberInput(altEl, 'alt'); });
  lockPosEl.addEventListener('change', () => {
    const next = lockPosEl.checked;
    void putPatch({ lockLat: next, lockLng: next });
  });
  lockAltEl.addEventListener('change', () => {
    void putPatch({ lockAlt: lockAltEl.checked });
  });
  capturedAtEl.addEventListener('change', () => {
    if (!cache) return;
    // datetime-local emits 'YYYY-MM-DDTHH:mm' in local time. new Date() of
    // that same string interprets it as local — round-tripping through
    // toISOString sends UTC to the server. Empty input clears the date.
    if (!capturedAtEl.value) {
      if (cache.capturedAt === null) return;
      void putPatch({ capturedAt: null });
      return;
    }
    const parsed = new Date(capturedAtEl.value);
    if (Number.isNaN(parsed.getTime())) {
      renderCapturedAt();
      return;
    }
    const next = parsed.toISOString();
    if (cache.capturedAt === next) return;
    void putPatch({ capturedAt: next });
  });

  return {
    hydrate,
    getNameAndAlt: () => cache && { name: cache.name, alt: cache.alt },
    getCapturedAt: () => cache?.capturedAt ?? null,
  };
}
