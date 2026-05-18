// Settings panel UI controls. Owns the DOM elements under #settings-panel,
// the settings-btn toggle, and the haze-slider's nonlinear mapping.
//
// Per-session knobs only — no persistence. The previous localStorage prefs
// layer was dropped because it raced with API hydration (e.g., a stale
// cameraHeight pref clobbering the just-solved station.alt). Anything that
// needs to survive a reload now comes from the API on hydrate.

import { HAZE_DENSITY_MAX } from './viewer.js';
import { solarAzAlt } from './solar.js';
import { setCurvatureEnabled, setRefractionEnabled } from './curvature.js';
import { attachDrag } from './dialog.js';
import { formatLocalDateTime, getElement } from './types.js';
import type { LatLng } from './types.js';
import type { Viewer } from './viewer.js';
import type { TerrainView } from './terrain/index.js';
import type { SunMarker } from './sun-marker.js';
import type { Sky } from './sky.js';

export interface SettingsPanel {
  refreshSunDirection(): void;
}

export interface CreateSettingsPanelOptions {
  viewer: Viewer;
  terrain: TerrainView;
  sunMarker: SunMarker;
  sky: Sky;
  getCameraLocation: () => LatLng | null;
  onShowAllCPsChange: (value: boolean) => void;
  // null = no limit; otherwise distance in meters. Observed CPs bypass.
  onCpMaxDistanceChange: (meters: number | null) => void;
  onSurfaceOpacityChange: (opacity: number) => void;
}

const HAZE_SLIDER_EXPONENT = 3;
function hazeSliderToDensity(v: number): number {
  return HAZE_DENSITY_MAX * Math.pow(v / 100, HAZE_SLIDER_EXPONENT);
}

export function createSettingsPanel({
  viewer, terrain, sunMarker, sky,
  getCameraLocation, onShowAllCPsChange, onCpMaxDistanceChange,
  onSurfaceOpacityChange,
}: CreateSettingsPanelOptions): SettingsPanel {
  const terrainToggleEl = getElement<HTMLInputElement>('terrain-toggle');
  const sunDateTimeEl = getElement<HTMLInputElement>('sun-datetime');
  const settingsBtnEl = getElement<HTMLButtonElement>('settings-btn');
  const settingsPanelEl = getElement('settings-panel');
  const hazeSliderEl = getElement<HTMLInputElement>('haze-slider');
  const skyTurbidityEl = getElement<HTMLInputElement>('sky-turbidity');
  const skyRayleighEl = getElement<HTMLInputElement>('sky-rayleigh');
  const skyMieCoefEl = getElement<HTMLInputElement>('sky-mie-coef');
  const skyMieGEl = getElement<HTMLInputElement>('sky-mie-g');
  const skyCloudCoverageEl = getElement<HTMLInputElement>('sky-cloud-coverage');
  const skyCloudDensityEl = getElement<HTMLInputElement>('sky-cloud-density');
  const skyCloudElevationEl = getElement<HTMLInputElement>('sky-cloud-elevation');
  const curvatureToggleEl = getElement<HTMLInputElement>('curvature-toggle');
  const refractionToggleEl = getElement<HTMLInputElement>('refraction-toggle');
  const showAllCPsEl = getElement<HTMLInputElement>('show-all-cps');
  const cpMaxDistanceEl = getElement<HTMLInputElement>('cp-max-distance');
  const surfaceOpacityEl = getElement<HTMLInputElement>('surface-opacity-slider');
  // Push the slider's HTML default into the renderer so it starts at the
  // same value the UI shows. Session-only — no localStorage, matching this
  // panel's policy.
  onSurfaceOpacityChange(parseFloat(surfaceOpacityEl.value) / 100);
  surfaceOpacityEl.addEventListener('input', () => {
    onSurfaceOpacityChange(parseFloat(surfaceOpacityEl.value) / 100);
  });

  // Default to May 20 at noon (this year) — bright, mid-spring sun gives a
  // legible scene regardless of when the page is loaded.
  sunDateTimeEl.value = formatLocalDateTime(new Date(new Date().getFullYear(), 4, 20, 12, 0));

  function refreshSunDirection(): void {
    const camLoc = getCameraLocation();
    if (!camLoc || !sunDateTimeEl.value) return;
    const date = new Date(sunDateTimeEl.value);
    if (Number.isNaN(date.getTime())) return;
    const { az, alt } = solarAzAlt(date, camLoc.lat, camLoc.lng);
    terrain.setSunDirection(az, alt);
    sunMarker.setDirection(az, alt);
    sky.setSunDirection(az, alt);
  }

  function refreshRefractionAvailability(): void {
    refractionToggleEl.disabled = !curvatureToggleEl.checked;
  }
  refreshRefractionAvailability();

  // Apply the checkbox's initial (HTML default = on) state, then listen.
  terrain.setMode(terrainToggleEl.checked ? 'shaded' : 'off');
  terrainToggleEl.addEventListener('change', () => {
    terrain.setMode(terrainToggleEl.checked ? 'shaded' : 'off');
  });

  sunDateTimeEl.addEventListener('change', () => {
    refreshSunDirection();
  });

  settingsBtnEl.addEventListener('click', () => {
    settingsPanelEl.hidden = !settingsPanelEl.hidden;
    settingsBtnEl.setAttribute('aria-expanded', String(!settingsPanelEl.hidden));
  });
  getElement<HTMLButtonElement>('settings-close').addEventListener('click', () => {
    settingsPanelEl.hidden = true;
    settingsBtnEl.setAttribute('aria-expanded', 'false');
  });
  attachDrag(settingsPanelEl);

  hazeSliderEl.addEventListener('input', () => {
    viewer.setFogDensity(hazeSliderToDensity(parseFloat(hazeSliderEl.value)));
  });

  // Push the HTML defaults into the sky now so the rendered probe matches
  // what the sliders read. Session-only — same policy as the rest of this
  // panel (no localStorage).
  sky.setParams({
    turbidity: parseFloat(skyTurbidityEl.value),
    rayleigh: parseFloat(skyRayleighEl.value),
    mieCoefficient: parseFloat(skyMieCoefEl.value),
    mieDirectionalG: parseFloat(skyMieGEl.value),
    cloudCoverage: parseFloat(skyCloudCoverageEl.value),
    cloudDensity: parseFloat(skyCloudDensityEl.value),
    cloudElevation: parseFloat(skyCloudElevationEl.value),
  });
  skyTurbidityEl.addEventListener('input', () => {
    sky.setParams({ turbidity: parseFloat(skyTurbidityEl.value) });
  });
  skyRayleighEl.addEventListener('input', () => {
    sky.setParams({ rayleigh: parseFloat(skyRayleighEl.value) });
  });
  skyMieCoefEl.addEventListener('input', () => {
    sky.setParams({ mieCoefficient: parseFloat(skyMieCoefEl.value) });
  });
  skyMieGEl.addEventListener('input', () => {
    sky.setParams({ mieDirectionalG: parseFloat(skyMieGEl.value) });
  });
  skyCloudCoverageEl.addEventListener('input', () => {
    sky.setParams({ cloudCoverage: parseFloat(skyCloudCoverageEl.value) });
  });
  skyCloudDensityEl.addEventListener('input', () => {
    sky.setParams({ cloudDensity: parseFloat(skyCloudDensityEl.value) });
  });
  skyCloudElevationEl.addEventListener('input', () => {
    sky.setParams({ cloudElevation: parseFloat(skyCloudElevationEl.value) });
  });

  curvatureToggleEl.addEventListener('change', () => {
    setCurvatureEnabled(curvatureToggleEl.checked);
    refreshRefractionAvailability();
  });

  refractionToggleEl.addEventListener('change', () => {
    setRefractionEnabled(refractionToggleEl.checked);
  });

  showAllCPsEl.addEventListener('change', () => {
    onShowAllCPsChange(showAllCPsEl.checked);
  });

  // 'input' (not 'change') so the cutoff updates live as the user types.
  cpMaxDistanceEl.addEventListener('input', () => {
    const n = parseFloat(cpMaxDistanceEl.value);
    onCpMaxDistanceChange(Number.isFinite(n) && n > 0 ? n : null);
  });

  return {
    refreshSunDirection,
  };
}
