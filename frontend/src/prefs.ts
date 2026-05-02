// Per-station view preferences stored in localStorage. The backend owns the
// authoritative station state (stations, photos, POIs); these are the
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

export function loadPrefs(stationId: string): Partial<Prefs> {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + stationId);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return {};
  } catch {
    return {};
  }
}

export function savePrefs(stationId: string, prefs: Prefs): void {
  try {
    localStorage.setItem(KEY_PREFIX + stationId, JSON.stringify(prefs));
  } catch {
    // localStorage full / disabled / private mode — non-fatal.
  }
}

// Merge a partial prefs object onto whatever's already on disk. Used by the
// station-create flow to seed just sunDateTime without fabricating defaults
// for every other field.
export function mergePrefs(stationId: string, partial: Partial<Prefs>): void {
  const current = loadPrefs(stationId);
  try {
    localStorage.setItem(KEY_PREFIX + stationId, JSON.stringify({ ...current, ...partial }));
  } catch {
    // localStorage full / disabled / private mode — non-fatal.
  }
}
