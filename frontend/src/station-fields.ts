// Station lat / lng / alt + per-axis solver locks.
//
// The settings panel exposes the station's stored lat/lng/alt and per-axis
// solver locks. Joint mode requires ≥2 stations with both lat and lng locked
// to fix translation+rotation gauge. We treat "lock location" as an atomic
// toggle on both lat and lng (locking only one wouldn't fix gauge anyway).
// "lock elevation" gates lock_alt; today the solver always treats station
// alt as a fixed input, so this lock is no-op-equivalent but kept for UI
// symmetry and forward-compat.

import * as api from './api.js';
import { getElement } from './types.js';
import type { LatLng } from './types.js';

export interface StationFields {
  name: string | null;
  lat: number; lng: number; alt: number;
  lockLat: boolean; lockLng: boolean; lockAlt: boolean;
}

export interface StationFieldsHandle {
  hydrate: (s: api.ApiStation) => void;
  // The fly-between animation needs the station's display name + altitude
  // before transitioning. Other cache fields (lat/lng/locks) are internal.
  getNameAndAlt: () => { name: string | null; alt: number } | null;
}

export interface CreateStationFieldsOptions {
  stationId: string;
  // Fires after every hydrate. Consumer typically does:
  //   if (terrain.setCameraHeight(alt)) refreshControlPointColumns();
  onAltitudeChanged: (alt: number) => void;
  // Fires only when a server PUT round-trip returns lat/lng different from
  // the cached values. Consumer typically calls applyCameraLocation(loc).
  onLocationChanged: (loc: LatLng) => void;
}

const fieldDigits = (key: 'lat' | 'lng' | 'alt'): number => key === 'alt' ? 2 : 6;

export function createStationFields(opts: CreateStationFieldsOptions): StationFieldsHandle {
  const { stationId, onAltitudeChanged, onLocationChanged } = opts;

  const latEl = getElement<HTMLInputElement>('station-lat');
  const lngEl = getElement<HTMLInputElement>('station-lng');
  const altEl = getElement<HTMLInputElement>('station-alt');
  const lockPosEl = getElement<HTMLInputElement>('station-lock-pos');
  const lockAltEl = getElement<HTMLInputElement>('station-lock-alt');

  // Local mirror of the canonical station fields, populated by hydrate().
  // Used for rendering inputs and detecting no-op edits; the PUT itself only
  // carries the changed key, so this is a display cache, not a round-trip
  // shim.
  let cache: StationFields | null = null;

  function render(): void {
    if (!cache) return;
    // Avoid clobbering an input the user is currently editing.
    if (document.activeElement !== latEl) latEl.value = cache.lat.toFixed(fieldDigits('lat'));
    if (document.activeElement !== lngEl) lngEl.value = cache.lng.toFixed(fieldDigits('lng'));
    if (document.activeElement !== altEl) altEl.value = cache.alt.toFixed(fieldDigits('alt'));
    lockPosEl.checked = cache.lockLat && cache.lockLng;
    lockAltEl.checked = cache.lockAlt;
  }

  function hydrate(s: api.ApiStation): void {
    cache = {
      name: s.name,
      lat: s.lat, lng: s.lng, alt: s.alt,
      lockLat: s.lock_lat, lockLng: s.lock_lng, lockAlt: s.lock_alt,
    };
    onAltitudeChanged(s.alt);
    render();
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
    let updated: api.ApiStation;
    try {
      updated = await api.updateStation(stationId, body);
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

  return {
    hydrate,
    getNameAndAlt: () => cache && { name: cache.name, alt: cache.alt },
  };
}
