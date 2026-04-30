// Per-project view preferences stored in localStorage. The backend owns the
// authoritative project state (locations, photos, POIs); these are the
// per-user UI knobs we don't want to share across collaborators.

import type { TerrainMode } from './terrain.js';

export interface Prefs {
  azimuth: number;
  altitude: number;
  fov: number;
  tab: '360' | 'map';
  lockCamera: boolean;
  solvePhotoRoll: boolean;
  terrainMode: TerrainMode;
  sunDateTime: string;     // YYYY-MM-DDTHH:mm
  cameraHeight: number;
  hazeDensity: number;
  curvatureEnabled: boolean;
  refractionEnabled: boolean;
}

const KEY_PREFIX = 'panorama-prefs:';

export function loadPrefs(locationId: string): Partial<Prefs> {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + locationId);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return {};
  } catch {
    return {};
  }
}

export function savePrefs(locationId: string, prefs: Prefs): void {
  try {
    localStorage.setItem(KEY_PREFIX + locationId, JSON.stringify(prefs));
  } catch {
    // localStorage full / disabled / private mode — non-fatal.
  }
}
