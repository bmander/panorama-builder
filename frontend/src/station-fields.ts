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
  createInconsistencyDetails, createSigmaSpan, feetToMeters, fmtSigmaMeters,
  formatEstimateRange, formatLocalDateTime, getElement, metersToFeet,
  sigmaSeverityClass, syncInputValue,
  updateSigma, worstHorizontalSigma,
} from './types.js';
import type { LatLng } from './types.js';
import { AUTO_LOCK_THRESHOLDS, applyLockState } from './auto-lock.js';
import type { StationAutoLock } from './auto-lock.js';
import { bindDisabledToSession, sessionStore } from './session-store.js';
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
  // Re-render the inputs against the current cache. Called when external
  // state (matched-obs count) changes the auto-lock affordance without
  // touching the canonical station fields themselves.
  refresh: () => void;
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
  // Polled on every render() so matched-obs changes surface without
  // re-hydrating from the API.
  getStationAutoLock: () => StationAutoLock;
}

const COORD_DIGITS = 6;
// The alt field is shown/edited in feet (backend stores metres); 1 dp is
// plenty for a height readout.
const ALT_FEET_DIGITS = 1;

export function createStationFields(opts: CreateStationFieldsOptions): StationFieldsHandle {
  const { getCurrentStationId, onAltitudeChanged, onLocationChanged, getStationAutoLock } = opts;

  const latEl = getElement<HTMLInputElement>('station-lat');
  const lngEl = getElement<HTMLInputElement>('station-lng');
  const altEl = getElement<HTMLInputElement>('station-alt');
  const lockPosEl = getElement<HTMLInputElement>('station-lock-pos');
  const lockAltEl = getElement<HTMLInputElement>('station-lock-alt');
  const capturedAtEl = getElement<HTMLInputElement>('station-captured-at');
  const capturedAtEstEl = getElement<HTMLSpanElement>('station-captured-at-est');

  // lockPosEl/lockAltEl intentionally omitted: applyLockState (called from
  // render below) folds editingActive() with the per-axis auto-lock flag,
  // and bindDisabledToSession would clobber the auto-lock bit on every
  // session toggle.
  for (const el of [latEl, lngEl, altEl, capturedAtEl]) {
    bindDisabledToSession(el);
  }
  // Re-render on session toggle so applyLockState re-fires for the locks.
  sessionStore.onChange(() => { render(); });

  const sigmaPosEl = createSigmaSpan(lngEl.parentElement!);
  const sigmaAltEl = createSigmaSpan(altEl.parentElement!);

  function renderSigma(s: api.ApiStation): void {
    const posLocked = s.lock_lat && s.lock_lng;
    sigmaPosEl.hidden = posLocked;
    if (!posLocked) {
      const worst = worstHorizontalSigma(s.sigma_lat, s.sigma_lng);
      updateSigma(sigmaPosEl, fmtSigmaMeters(worst),
        sigmaSeverityClass(worst, SIGMA_POS_WARN_M, SIGMA_POS_REFUSE_M),
        'σ from last solve (max of lat/lng, in feet)');
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
    syncInputValue(latEl, cache.lat.toFixed(COORD_DIGITS));
    syncInputValue(lngEl, cache.lng.toFixed(COORD_DIGITS));
    syncInputValue(altEl, metersToFeet(cache.alt).toFixed(ALT_FEET_DIGITS));
    if (document.activeElement !== capturedAtEl) renderCapturedAt();
    // The combined position toggle is the AND of the per-axis flags — if
    // only lat OR only lng is auto-locked the user still has no useful
    // single-toggle behaviour, so we require both.
    const auto = getStationAutoLock();
    applyLockState(lockPosEl, cache.lockLat && cache.lockLng, auto.lat && auto.lng, AUTO_LOCK_THRESHOLDS.lat);
    applyLockState(lockAltEl, cache.lockAlt, auto.alt, AUTO_LOCK_THRESHOLDS.alt);
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
    // The alt field is in feet; compare in feet, then convert back to metres
    // for the patch.
    if (key === 'alt') {
      if (metersToFeet(cache.alt).toFixed(ALT_FEET_DIGITS) === n.toFixed(ALT_FEET_DIGITS)) {
        render();
        return;
      }
      void putPatch({ alt: feetToMeters(n) });
      return;
    }
    if (cache[key].toFixed(COORD_DIGITS) === n.toFixed(COORD_DIGITS)) {
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
    refresh: render,
    getNameAndAlt: () => cache && { name: cache.name, alt: cache.alt },
    getCapturedAt: () => cache?.capturedAt ?? null,
  };
}
