// Settings panel UI controls + per-station view preferences. Owns the DOM
// elements under #settings-panel, the settings-btn toggle, the haze-slider's
// nonlinear mapping, and the persist/apply round-trip with localStorage.

import { HAZE_DENSITY_MAX } from './viewer.js';
import { savePrefs, type Prefs } from './prefs.js';
import { solarAzAlt } from './solar.js';
import { formatLocalDateTime, getElement } from './types.js';
import type { LatLng } from './types.js';
import type { Viewer } from './viewer.js';
import type { TerrainView, TerrainMode } from './terrain.js';
import type { SunMarker } from './sun-marker.js';
import type { Hud } from './ui.js';

export interface SettingsPanel {
  persist(): void;
  apply(prefs: Partial<Prefs>): void;
  refreshSunDirection(): void;
  isSolveRollEnabled(): boolean;
}

export interface CreateSettingsPanelOptions {
  viewer: Viewer;
  terrain: TerrainView;
  sunMarker: SunMarker;
  hud: Hud;
  getCameraLocation: () => LatLng | null;
  getCurrentStationId: () => string | null;
  getViewTab: () => '360' | 'map';
  refreshMapAnnotationsIfVisible: () => void;
  runSolve: () => void;
  setCameraLocked: (locked: boolean) => void;
}

const HAZE_SLIDER_EXPONENT = 3;
function hazeSliderToDensity(v: number): number {
  return HAZE_DENSITY_MAX * Math.pow(v / 100, HAZE_SLIDER_EXPONENT);
}
function hazeDensityToSlider(d: number): number {
  if (d <= 0) return 0;
  return Math.pow(d / HAZE_DENSITY_MAX, 1 / HAZE_SLIDER_EXPONENT) * 100;
}

export function createSettingsPanel({
  viewer, terrain, sunMarker, hud,
  getCameraLocation, getCurrentStationId, getViewTab,
  refreshMapAnnotationsIfVisible, runSolve, setCameraLocked,
}: CreateSettingsPanelOptions): SettingsPanel {
  const lockCameraEl = getElement<HTMLInputElement>('lock-camera');
  const terrainModeEl = getElement<HTMLSelectElement>('terrain-mode');
  const sunDateTimeEl = getElement<HTMLInputElement>('sun-datetime');
  const settingsBtnEl = getElement<HTMLButtonElement>('settings-btn');
  const settingsPanelEl = getElement('settings-panel');
  const hazeSliderEl = getElement<HTMLInputElement>('haze-slider');
  const curvatureToggleEl = getElement<HTMLInputElement>('curvature-toggle');
  const refractionToggleEl = getElement<HTMLInputElement>('refraction-toggle');
  const solveRollToggleEl = getElement<HTMLInputElement>('solve-roll-toggle');

  sunDateTimeEl.value = formatLocalDateTime(new Date());

  function persistNow(): void {
    const id = getCurrentStationId();
    if (!id) return;
    const { azimuth, altitude } = viewer.getAzAlt();
    const prefs: Prefs = {
      azimuth, altitude,
      fov: viewer.camera.fov,
      tab: getViewTab(),
      lockCamera: lockCameraEl.checked,
      solvePhotoRoll: solveRollToggleEl.checked,
      terrainMode: terrain.getMode(),
      sunDateTime: sunDateTimeEl.value,
      cameraHeight: terrain.getCameraHeight(),
      hazeDensity: hazeSliderToDensity(parseFloat(hazeSliderEl.value)),
      curvatureEnabled: terrain.getCurvatureEnabled(),
      refractionEnabled: terrain.getRefractionEnabled(),
    };
    savePrefs(id, prefs);
  }
  // input.ts calls persist() on every pointermove during a pan; debounce
  // so localStorage isn't hammered at 60 Hz.
  let persistTimer: number | null = null;
  function persist(): void {
    if (persistTimer !== null) return;
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, 250);
  }
  addEventListener('beforeunload', () => {
    if (persistTimer !== null) { clearTimeout(persistTimer); persistTimer = null; }
    persistNow();
  });

  function apply(p: Partial<Prefs>): void {
    if (p.azimuth !== undefined && p.altitude !== undefined) viewer.setAzAlt(p.azimuth, p.altitude);
    if (p.fov !== undefined) viewer.setFov(p.fov);
    if (p.lockCamera !== undefined) {
      lockCameraEl.checked = p.lockCamera;
      setCameraLocked(p.lockCamera);
    }
    if (p.solvePhotoRoll !== undefined) solveRollToggleEl.checked = p.solvePhotoRoll;
    if (p.cameraHeight !== undefined) terrain.setCameraHeight(p.cameraHeight);
    if (p.hazeDensity !== undefined) {
      viewer.setFogDensity(p.hazeDensity);
      hazeSliderEl.value = String(Math.round(hazeDensityToSlider(p.hazeDensity)));
    }
    if (p.curvatureEnabled !== undefined) {
      curvatureToggleEl.checked = p.curvatureEnabled;
      terrain.setCurvatureEnabled(p.curvatureEnabled);
    }
    if (p.refractionEnabled !== undefined) {
      refractionToggleEl.checked = p.refractionEnabled;
      terrain.setRefractionEnabled(p.refractionEnabled);
    }
    refreshRefractionAvailability();
    if (p.sunDateTime !== undefined) sunDateTimeEl.value = p.sunDateTime;
    if (p.terrainMode !== undefined) {
      terrainModeEl.value = p.terrainMode;
      terrain.setMode(p.terrainMode);
    }
    // tab is applied last by the caller (after location restore so map can paint).
  }

  function refreshSunDirection(): void {
    const camLoc = getCameraLocation();
    if (!camLoc || !sunDateTimeEl.value) return;
    const date = new Date(sunDateTimeEl.value);
    if (Number.isNaN(date.getTime())) return;
    const { az, alt } = solarAzAlt(date, camLoc.lat, camLoc.lng);
    terrain.setSunDirection(az, alt);
    sunMarker.setDirection(az, alt);
  }

  function refreshRefractionAvailability(): void {
    refractionToggleEl.disabled = !curvatureToggleEl.checked;
  }
  refreshRefractionAvailability();

  setCameraLocked(lockCameraEl.checked);
  lockCameraEl.addEventListener('change', () => {
    setCameraLocked(lockCameraEl.checked);
    runSolve();
    viewer.requestRender();
    refreshMapAnnotationsIfVisible();
    hud.refresh();
    persist();
  });

  terrainModeEl.addEventListener('change', () => {
    terrain.setMode(terrainModeEl.value as TerrainMode);
    persist();
  });

  sunDateTimeEl.addEventListener('change', () => {
    refreshSunDirection();
    persist();
  });

  settingsBtnEl.addEventListener('click', () => {
    settingsPanelEl.hidden = !settingsPanelEl.hidden;
    settingsBtnEl.setAttribute('aria-expanded', String(!settingsPanelEl.hidden));
  });

  hazeSliderEl.addEventListener('input', () => {
    viewer.setFogDensity(hazeSliderToDensity(parseFloat(hazeSliderEl.value)));
    persist();
  });

  curvatureToggleEl.addEventListener('change', () => {
    terrain.setCurvatureEnabled(curvatureToggleEl.checked);
    refreshRefractionAvailability();
    persist();
  });

  refractionToggleEl.addEventListener('change', () => {
    terrain.setRefractionEnabled(refractionToggleEl.checked);
    persist();
  });

  solveRollToggleEl.addEventListener('change', () => {
    runSolve();
    persist();
  });

  return {
    persist,
    apply,
    refreshSunDirection,
    isSolveRollEnabled(): boolean { return solveRollToggleEl.checked; },
  };
}
