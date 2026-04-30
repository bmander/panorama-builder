import * as THREE from 'three';
import { createViewer, HAZE_DENSITY_MAX } from './viewer.js';
import { createOverlayManager } from './overlay.js';
import { createBaker } from './bake.js';
import { attachInput } from './input.js';
import { createHud, attachViewTabs, attachDownload, attachToolPalette } from './ui.js';
import { createMapView } from './map.js';
import { solveJointPose, autoLocalFreeParams } from './solver.js';
import { getElement, meshMat, overlayData, poiData } from './types.js';
import type { JointPhoto, LatLng, SolverParam } from './types.js';
import { openStore } from './persistence.js';
import type { AppSnapshot, Store } from './persistence.js';
import { createTerrainView } from './terrain.js';
import type { TerrainMode } from './terrain.js';
import { solarAzAlt } from './solar.js';
import { createSunMarker } from './sun-marker.js';

// Open IDB before building UI; null on private mode / unsupported.
const store: Store | null = await openStore();
const persisted = await store?.loadAll() ?? null;

const viewer = createViewer({ container: document.body });

let isSolving = false;
// Re-entrancy guard around the solver: applyPose triggers onMutate, which would
// otherwise recursively re-enter solveAllPhotos. Used by every code path that
// can request a solve (mutation notify, location change, lock toggle).
function runSolve(): void {
  if (isSolving) return;
  isSolving = true;
  try { solveAllPhotos(); } finally { isSolving = false; }
}

const overlays = createOverlayManager({
  overlaysGroup: viewer.overlaysGroup,
  getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
  onMutate: () => {
    viewer.requestRender();
    baker.markDirty();
    // Skip the map work entirely when the map tab isn't showing — getCones /
    // getPOIs walk every overlay and dirty their world matrices for nothing.
    if (mapView.isVisible()) refreshMapAnnotations();
    runSolve();
    save();
  },
});

function refreshMapAnnotations(): void {
  mapView.setOverlayCones(overlays.getCones());
  mapView.setPOIBearings(overlays.getPOIs());
}

const terrain = createTerrainView({
  scene: viewer.scene,
  requestRender: () => { viewer.requestRender(); },
});

const sunMarker = createSunMarker({
  scene: viewer.scene,
  requestRender: () => { viewer.requestRender(); },
});

const baker = createBaker({
  renderer: viewer.renderer,
  scene: viewer.scene,
  // Hide only the authoring overlays (selection outlines, handles, POI dots).
  // Terrain, sun, and fog stay visible so the Flat tab and the downloaded PNG
  // match what the user composed in the 360° viewer.
  setVisualsVisible: visible => { overlays.setVisualsVisible(visible); },
});

const hud = createHud(() => {
  const { azimuth, altitude } = viewer.getAzAlt();
  const sel = overlays.getSelected();
  return {
    azimuth, altitude,
    fov: viewer.camera.fov,
    selectedSizeRad: sel ? overlayData(sel).sizeRad : null,
    cameraHeight: terrain.getCameraHeight(),
  };
});

const coordsEl = getElement('map-coords');
coordsEl.textContent = 'no location set — click "Set location"';

// Side-effects that apply both to interactive map clicks AND programmatic
// camera moves (solver, restore). mapView.setLocation deliberately doesn't
// fire onLocationChange (to avoid feedback loops in the solver), so callers
// that move the camera must propagate to terrain + coords themselves.
function applyCameraLocation(loc: LatLng): void {
  coordsEl.textContent = `lat ${loc.lat.toFixed(5)}  lng ${loc.lng.toFixed(5)}`;
  terrain.setLocation(loc);
  refreshSunDirection();
}

// User-configurable solver locks. When a parameter is locked, autoFreeParams's
// suggestion is filtered down so the solver leaves it fixed. Locking the camera
// position (camLat + camLng) turns 4+ POI fits into a least-squares solve over
// photoAz/sizeRad only.
const lockedParams = new Set<SolverParam>();
function applyCameraLock(locked: boolean): void {
  if (locked) { lockedParams.add('camLat'); lockedParams.add('camLng'); }
  else { lockedParams.delete('camLat'); lockedParams.delete('camLng'); }
}
const lockCameraEl = getElement<HTMLInputElement>('lock-camera');
applyCameraLock(lockCameraEl.checked);
lockCameraEl.addEventListener('change', () => {
  applyCameraLock(lockCameraEl.checked);
  runSolve();
  // Cover the no-solve-happened case: if zero photos have anchored POIs, the
  // solver was a no-op and onMutate didn't fire. Refresh visuals anyway so the
  // user sees a response to the toggle.
  viewer.requestRender();
  if (mapView.isVisible()) refreshMapAnnotations();
  hud.refresh();
  save();
});

const terrainModeEl = getElement<HTMLSelectElement>('terrain-mode');
const sunDateTimeEl = getElement<HTMLInputElement>('sun-datetime');

// Default the sun picker to "now" so shaded mode is meaningful immediately.
sunDateTimeEl.value = formatLocalDateTime(new Date());

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function formatLocalDateTime(d: Date): string {
  return `${d.getFullYear().toString()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function refreshSunDirection(): void {
  const camLoc = mapView.getLocation();
  if (!camLoc || !sunDateTimeEl.value) return;
  // <input type="datetime-local"> values have no timezone — Date() parses them
  // as local civil time, which is what the picker shows.
  const date = new Date(sunDateTimeEl.value);
  if (Number.isNaN(date.getTime())) return;
  const { az, alt } = solarAzAlt(date, camLoc.lat, camLoc.lng);
  terrain.setSunDirection(az, alt);
  sunMarker.setDirection(az, alt);
}

terrainModeEl.addEventListener('change', () => {
  terrain.setMode(terrainModeEl.value as TerrainMode);
  save();
});
sunDateTimeEl.addEventListener('change', () => {
  refreshSunDirection();
  save();
});

const settingsBtnEl = getElement<HTMLButtonElement>('settings-btn');
const settingsPanelEl = getElement('settings-panel');
settingsBtnEl.addEventListener('click', () => {
  settingsPanelEl.hidden = !settingsPanelEl.hidden;
  settingsBtnEl.setAttribute('aria-expanded', String(!settingsPanelEl.hidden));
});

// Cubic mapping: slider's lower half adjusts subtle "atmospheric" haze with
// fine resolution; the upper half ramps quickly into wildfire-smoke territory.
const HAZE_SLIDER_EXPONENT = 3;
function hazeSliderToDensity(v: number): number {
  return HAZE_DENSITY_MAX * Math.pow(v / 100, HAZE_SLIDER_EXPONENT);
}
function hazeDensityToSlider(d: number): number {
  if (d <= 0) return 0;
  return Math.pow(d / HAZE_DENSITY_MAX, 1 / HAZE_SLIDER_EXPONENT) * 100;
}

const hazeSliderEl = getElement<HTMLInputElement>('haze-slider');
hazeSliderEl.addEventListener('input', () => {
  viewer.setFogDensity(hazeSliderToDensity(parseFloat(hazeSliderEl.value)));
  save();
});

const curvatureToggleEl = getElement<HTMLInputElement>('curvature-toggle');
const refractionToggleEl = getElement<HTMLInputElement>('refraction-toggle');
function refreshRefractionAvailability(): void {
  refractionToggleEl.disabled = !curvatureToggleEl.checked;
}
curvatureToggleEl.addEventListener('change', () => {
  terrain.setCurvatureEnabled(curvatureToggleEl.checked);
  refreshRefractionAvailability();
  save();
});
refractionToggleEl.addEventListener('change', () => {
  terrain.setRefractionEnabled(refractionToggleEl.checked);
  save();
});
refreshRefractionAvailability();

// Run the joint photo-pose solver across every overlay with anchored POIs.
// All photos share one camera location, so POIs from every photo contribute
// evidence to it; each photo's photoAz/sizeRad is local. The solver decides
// whether the camera is solvable (enough spare equations) and whether the
// user has locked it.
function solveAllPhotos(): void {
  const camLoc = mapView.getLocation();
  if (!camLoc) return;

  interface PhotoEntry {
    overlay: THREE.Group;
    photo: JointPhoto;
  }
  const entries: PhotoEntry[] = [];
  for (const o of overlays.listOverlays() as THREE.Group[]) {
    const anchored = (overlayData(o).pois ?? []).filter(p => poiData(p).mapAnchor);
    if (anchored.length === 0) continue;
    entries.push({
      overlay: o,
      photo: {
        pose: overlays.extractPose(o, camLoc),
        pois: anchored.map(p => {
          const pd = poiData(p);
          const anchor = pd.mapAnchor!;
          return {
            u: pd.uv.u, v: pd.uv.v,
            anchorLat: anchor.lat, anchorLng: anchor.lng,
          };
        }),
        free: autoLocalFreeParams(anchored.length),
      },
    });
  }
  if (entries.length === 0) return;

  // Solve camera only if not locked AND there are enough spare POIs after the
  // local unknowns are accounted for. Camera has 2 DOF (camLat, camLng), so
  // we need at least 2 more POIs than the sum of per-photo free params.
  const totalPois = entries.reduce((s, e) => s + e.photo.pois.length, 0);
  const localUnknowns = entries.reduce((s, e) => s + e.photo.free.length, 0);
  const cameraLocked = lockedParams.has('camLat') || lockedParams.has('camLng');
  const solveCamera = !cameraLocked && totalPois >= localUnknowns + 2;

  // Holder object so the closure can record a value TS will see post-call.
  // (TS doesn't narrow `let` mutations through callbacks; a wrapper does.)
  const proposed: { camLoc: LatLng | null } = { camLoc: null };
  overlays.withBatch(() => {
    const result = solveJointPose({
      camLoc,
      photos: entries.map(e => e.photo),
      solveCamera,
    });
    entries.forEach((e, i) => { overlays.applyPose(e.overlay, result.photos[i]!.pose); });
    if (result.cameraMoved) proposed.camLoc = result.camLoc;
  });
  // Apply camera move outside the batch so the map's marker updates after pose writes settle.
  if (proposed.camLoc) {
    mapView.setLocation(proposed.camLoc);
    applyCameraLocation(proposed.camLoc);
  }
}

const setLocationBtn = getElement('set-location');
const mapView = createMapView({
  container: getElement('map'),
  // Force a refresh when the map tab becomes visible — onMutate skips the
  // refresh while the map is hidden, so the caches may be stale here.
  onShowRefresh: () => { refreshMapAnnotations(); },
  onLocationChange: loc => {
    applyCameraLocation(loc);
    runSolve();
    save();
  },
  onPOIAnchorClick: (handle, latlng) => {
    overlays.setPOIMapAnchor(handle, latlng);
  },
  onPOIAnchorDragged: (handle, latlng /*, viewerAz */) => {
    overlays.withBatch(() => {
      overlays.setPOIMapAnchor(handle, latlng);
      // Solver runs via onMutate after the batch closes; no per-handle rotate needed.
    });
  },
  onArmedChange: armed => {
    setLocationBtn.classList.toggle('armed', armed);
    setLocationBtn.textContent = armed ? 'Click map to set…' : 'Set location';
  },
});
setLocationBtn.addEventListener('click', () => { mapView.toggleSetLocationArmed(); });

// Shift-wheel adjusts terrain camera height in signed-log space so a single
// tick is fine near 0 (≈0.65 m at h=0) and grows with altitude (≈3 m at 5 m,
// ≈65 m at 100 m, ≈650 m at 1000 m). Increment in log-space, transform back.
// Scroll-up (negative deltaY) raises the camera.
const SHIFT_WHEEL_LOG_PER_PX = 0.005;

const opacityRowEl = getElement('overlay-opacity-row');
const opacitySliderEl = getElement<HTMLInputElement>('overlay-opacity');

function refreshSelectionUI(): void {
  const opacity = overlays.getSelectedOpacity();
  if (opacity === null) {
    opacityRowEl.style.display = 'none';
    return;
  }
  opacityRowEl.style.display = '';
  opacitySliderEl.value = String(Math.round(opacity * 100));
}

opacitySliderEl.addEventListener('input', () => {
  overlays.setSelectedOpacity(parseFloat(opacitySliderEl.value) / 100);
  viewer.requestRender();
  baker.markDirty();
  save();
});

const input = attachInput({
  viewer,
  overlays,
  onChange: () => { viewer.requestRender(); hud.refresh(); refreshSelectionUI(); save(); },
  onOverlayAdded: (overlay, blob) => {
    void store?.saveBlob(overlayData(overlay).id, blob);
  },
  onShiftWheel: deltaPx => {
    const h = terrain.getCameraHeight();
    const s = Math.sign(h) * Math.log1p(Math.abs(h)) - deltaPx * SHIFT_WHEEL_LOG_PER_PX;
    const next = Math.sign(s) * Math.expm1(Math.abs(s));
    if (!terrain.setCameraHeight(next)) return;
    hud.refresh();
    save();
  },
});
const viewTabs = attachViewTabs({ baker, viewer, hud, mapView });
// Authoring controls (tools, locks panel) only matter in the 360° viewer
// where the user is composing the panorama. Hide them on the Flat / Map tabs.
const toolsEl = getElement('tools');
const locksEl = getElement('locks');
viewTabs.onModeChange(mode => {
  const is360 = mode === '360';
  toolsEl.style.display = is360 ? '' : 'none';
  locksEl.style.display = is360 ? '' : 'none';
  save();
});
attachDownload({ baker });
attachToolPalette({ input });

function getSnapshot(): AppSnapshot {
  const camLoc = mapView.getLocation();
  const overlaysSnap = (overlays.listOverlays() as THREE.Group[]).map(g => {
    const data = overlayData(g);
    const pose = overlays.extractPose(g, camLoc);
    return {
      id: data.id,
      sizeRad: pose.sizeRad,
      aspect: pose.aspect,
      photoAz: pose.photoAz,
      photoTilt: pose.photoTilt,
      photoRoll: pose.photoRoll,
      opacity: meshMat(data.body).opacity,
      pois: (data.pois ?? []).map(p => {
        const pd = poiData(p);
        return { u: pd.uv.u, v: pd.uv.v, mapAnchor: pd.mapAnchor };
      }),
    };
  });
  const { azimuth, altitude } = viewer.getAzAlt();
  return {
    version: 1,
    camLoc,
    azimuth,
    altitude,
    fov: viewer.camera.fov,
    tab: viewTabs.getMode(),
    tool: input.getTool(),
    lockCamera: lockCameraEl.checked,
    terrainMode: terrain.getMode(),
    sunDateTime: sunDateTimeEl.value,
    cameraHeight: terrain.getCameraHeight(),
    hazeDensity: hazeSliderToDensity(parseFloat(hazeSliderEl.value)),
    curvatureEnabled: terrain.getCurvatureEnabled(),
    refractionEnabled: terrain.getRefractionEnabled(),
    overlays: overlaysSnap,
  };
}

function save(): void {
  if (restoring) return; // ignore self-induced saves while replaying
  store?.scheduleSave(getSnapshot);
}

input.onToolChange(() => { save(); });

// --- Restore from persisted state, if any ---
let restoring = false;
if (persisted) {
  restoring = true;
  const { snapshot, blobs } = persisted;
  // Sun datetime restored before camLoc so applyCameraLocation's sun refresh
  // sees the saved time rather than the default "now".
  if (snapshot.sunDateTime !== undefined) sunDateTimeEl.value = snapshot.sunDateTime;
  if (snapshot.camLoc) {
    mapView.setLocation(snapshot.camLoc);
    applyCameraLocation(snapshot.camLoc);
  }
  viewer.setAzAlt(snapshot.azimuth, snapshot.altitude);
  viewer.setFov(snapshot.fov);
  lockCameraEl.checked = snapshot.lockCamera;
  applyCameraLock(snapshot.lockCamera);
  input.setTool(snapshot.tool);
  if (snapshot.cameraHeight !== undefined) terrain.setCameraHeight(snapshot.cameraHeight);
  if (snapshot.hazeDensity !== undefined) {
    viewer.setFogDensity(snapshot.hazeDensity);
    hazeSliderEl.value = String(Math.round(hazeDensityToSlider(snapshot.hazeDensity)));
  }
  if (snapshot.curvatureEnabled !== undefined) {
    curvatureToggleEl.checked = snapshot.curvatureEnabled;
    terrain.setCurvatureEnabled(snapshot.curvatureEnabled);
  }
  if (snapshot.refractionEnabled !== undefined) {
    refractionToggleEl.checked = snapshot.refractionEnabled;
    terrain.setRefractionEnabled(snapshot.refractionEnabled);
  }
  refreshRefractionAvailability();
  const restoredMode: TerrainMode =
    snapshot.terrainMode ?? (snapshot.terrainEnabled ? 'wireframe' : 'off');
  terrainModeEl.value = restoredMode;
  terrain.setMode(restoredMode);

  const loader = new THREE.TextureLoader();
  await Promise.all(snapshot.overlays.map(snap => new Promise<void>(resolve => {
    const blob = blobs.get(snap.id);
    if (!blob) { resolve(); return; }
    const url = URL.createObjectURL(blob);
    loader.load(url, tex => {
      overlays.restoreOverlay(tex, snap);
      URL.revokeObjectURL(url);
      resolve();
    }, undefined, () => {
      URL.revokeObjectURL(url);
      resolve();
    });
  })));

  // Tab last — switching to map/flat triggers Leaflet/bake which need
  // overlays in place. Default to '360' if persisted value is invalid.
  viewTabs.setMode(snapshot.tab);
  restoring = false;
}

hud.refresh();
refreshSelectionUI();
viewer.start();
