import * as THREE from 'three';
import { createViewer, HAZE_DENSITY_MAX } from './viewer.js';
import { createOverlayManager } from './overlay.js';
import { createBaker } from './bake.js';
import { attachInput } from './input.js';
import { createHud, attachViewTabs, attachDownload, triggerDownload } from './ui.js';
import { createMapView } from './map.js';
import { solveJointPose, autoLocalFreeParams } from './solver.js';
import { getElement, meshMat, overlayData, poiData } from './types.js';
import type { JointPhoto, LatLng, SolverParam } from './types.js';
import { openStore, isAppSnapshot } from './persistence.js';
import type { AppSnapshot, Store } from './persistence.js';
import { createTerrainView } from './terrain.js';
import type { TerrainMode } from './terrain.js';
import { solarAzAlt } from './solar.js';
import { createSunMarker } from './sun-marker.js';
import { createMapPoiColumns, COLUMN_Y_MIN_M, COLUMN_Y_MAX_M } from './map-poi-columns.js';
import type { MapPoiColumn } from './map-poi-columns.js';
import { latLngToCameraRelativeMeters } from './geo.js';

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
    refreshMapPoiColumns();
    runSolve();
    save();
  },
  // Skip the solver/save cascade — only the cross-view highlight visuals depend on selection.
  onSelectionChange: () => {
    viewer.requestRender();
    if (mapView.isVisible()) refreshMapAnnotations();
    refreshMapPoiColumns();
  },
});

function refreshMapAnnotations(): void {
  mapView.setOverlayCones(overlays.getCones());
  mapView.setPOIBearings(overlays.getPOIs());
  mapView.setMapPOIs(overlays.getMapPOIs());
}

function refreshMapPoiColumns(): void {
  // Columns only render in the 360° tab — skip the work entirely when the
  // user is on the Map tab. Critical during live solver iterations: each
  // anchor drag fires onMutate at ~60 Hz while the 360° viewer is hidden.
  // The onModeChange handler refreshes once on tab-switch back to 360°.
  if (viewTabs.getMode() !== '360') return;
  const camLoc = mapView.getLocation();
  const columns: MapPoiColumn[] = [];
  for (const p of overlays.getPOIs()) {
    // Photo-anchored POIs share the column ids of the host POI's mesh uuid —
    // any stable string works since this id is only consumed by the columns
    // module's hover lookup, and photo-anchored POIs don't participate in
    // the hover-to-match flow (matching only applies to standalone map-POIs).
    if (p.mapAnchor) columns.push({ id: p.handle.uuid, anchor: p.mapAnchor, selected: p.selected });
  }
  for (const m of overlays.getMapPOIs()) {
    columns.push({ id: m.id, anchor: m.latlng, selected: m.selected });
  }
  mapPoiColumns.update(camLoc, columns);
}

const terrain = createTerrainView({
  scene: viewer.scene,
  requestRender: () => { viewer.requestRender(); },
});

const sunMarker = createSunMarker({
  scene: viewer.scene,
  requestRender: () => { viewer.requestRender(); },
});

const mapPoiColumns = createMapPoiColumns({
  scene: viewer.scene,
  requestRender: () => { viewer.requestRender(); },
});

const baker = createBaker({
  renderer: viewer.renderer,
  scene: viewer.scene,
  // Hide only the authoring overlays (selection outlines, handles, POI dots,
  // map-anchor columns). Terrain, sun, and fog stay visible so the Flat tab
  // and the downloaded PNG match what the user composed in the 360° viewer.
  setVisualsVisible: visible => {
    overlays.setVisualsVisible(visible);
    mapPoiColumns.setVisible(visible);
  },
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
  refreshMapPoiColumns();
  applyLocationGate();
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

const solveRollToggleEl = getElement<HTMLInputElement>('solve-roll-toggle');
solveRollToggleEl.addEventListener('change', () => {
  // Re-solve so the new free-param set takes effect immediately.
  runSolve();
  save();
});

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
        free: autoLocalFreeParams(anchored.length, solveRollToggleEl.checked),
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

const addPoiBtnEl = getElement('add-poi');
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
  onPOIAnchorMarkerClick: handle => { overlays.setSelectedPOI(handle); },
  onMapPoiArmedAddClick: latlng => { overlays.addMapPOI(latlng); },
  onMapPoiClick: id => { overlays.setSelectedMapPOI(id); },
  onMapPoiDragged: (id, latlng) => {
    overlays.withBatch(() => { overlays.setMapPOILatLng(id, latlng); });
  },
  onArmedChange: armed => {
    setLocationBtn.classList.toggle('armed', armed);
    setLocationBtn.textContent = armed ? 'Click map to set…' : 'Set location';
  },
  onMapPoiArmedChange: armed => { addPoiBtnEl.classList.toggle('armed', armed); },
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

// Screen-space hit radius for the matcher: a click within this NDC distance
// of a column's projected line segment counts as a hit. ~0.04 ≈ 40 px on a
// 1080-tall viewport — generous enough that thin column lines are easy to grab.
const COLUMN_NDC_HIT_RADIUS = 0.04;
const _baseProjected = new THREE.Vector3();
const _topProjected = new THREE.Vector3();
// Distance in NDC from point p to the segment a-b (2D, ignoring z).
function ndcSegmentDistance(p: { x: number; y: number }, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / lenSq)) : 0;
  return Math.hypot(apx - t * abx, apy - t * aby);
}
// Only standalone map-POI columns are hover-matchable — matching a
// photo-anchored column would create a duplicate paired POI at the same
// lat/lng, which isn't useful.
function findColumnAtNDC(ndc: { x: number; y: number }): { id: string; latlng: LatLng } | null {
  const camLoc = mapView.getLocation();
  if (!camLoc) return null;
  let best: { id: string; latlng: LatLng } | null = null;
  let bestDist = COLUMN_NDC_HIT_RADIUS;
  for (const m of overlays.getMapPOIs()) {
    const { x, z } = latLngToCameraRelativeMeters(m.latlng, camLoc);
    _baseProjected.set(x, COLUMN_Y_MIN_M, z).project(viewer.camera);
    _topProjected.set(x, COLUMN_Y_MAX_M, z).project(viewer.camera);
    // Both endpoints behind the camera → segment isn't visible at all.
    if (_baseProjected.z > 1 && _topProjected.z > 1) continue;
    const d = ndcSegmentDistance(ndc, _baseProjected, _topProjected);
    if (d < bestDist) { bestDist = d; best = { id: m.id, latlng: m.latlng }; }
  }
  return best;
}

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
  onPoiArmChange: armed => { addPoiBtnEl.classList.toggle('armed', armed); },
  findColumnAtNDC,
  onHoveredColumnChange: id => { mapPoiColumns.setHoveredColumn(id); },
});
// + POI is contextual: on 360° it arms photo-POI placement; on Map it arms
// standalone-map-POI placement. Both armed states share the button's glow.
addPoiBtnEl.addEventListener('click', () => {
  if (viewTabs.getMode() === '360') input.togglePoiArm();
  else mapView.toggleMapPoiArm();
});
const viewTabs = attachViewTabs({ viewer, hud, mapView });
viewTabs.onModeChange(mode => {
  // Disarm all armed states on tab switch so stale arming doesn't carry.
  input.disarmPoi();
  mapView.disarmAll();
  if (mode === '360') refreshMapPoiColumns();
  save();
});

// Until the user sets a camera location on the Map, the 360° viewer has
// nothing to show. Disable the 360° tab and force-switch to Map; re-enable
// once a location lands. Called from applyCameraLocation (any location set)
// and once at startup (covers fresh-start + restore-without-location).
const tab360El = getElement<HTMLButtonElement>('tab-360');
function applyLocationGate(): void {
  const hasLocation = mapView.getLocation() !== null;
  tab360El.disabled = !hasLocation;
  tab360El.title = hasLocation ? '' : 'Set a camera location on the Map first';
  if (!hasLocation && viewTabs.getMode() === '360') viewTabs.setMode('map');
}
attachDownload({ baker });

// --- Save / Load project bundle (single-file JSON download) ---

interface ProjectBundle {
  readonly version: 1;
  readonly snapshot: AppSnapshot;
  readonly photos: Record<string, { mime: string; data: string }>;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (): void => {
      const url = r.result as string;
      resolve(url.slice(url.indexOf(',') + 1));
    };
    r.onerror = (): void => { reject(r.error ?? new Error('FileReader failed')); };
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function isValidBundle(v: unknown): v is ProjectBundle {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (!isAppSnapshot(obj.snapshot)) return false;
  if (typeof obj.photos !== 'object' || obj.photos === null) return false;
  for (const photo of Object.values(obj.photos as Record<string, unknown>)) {
    if (typeof photo !== 'object' || photo === null) return false;
    const p = photo as Record<string, unknown>;
    if (typeof p.mime !== 'string' || typeof p.data !== 'string') return false;
  }
  return true;
}

const saveBundleBtn = getElement('save-bundle');
saveBundleBtn.addEventListener('click', () => {
  void (async (): Promise<void> => {
    if (!store) return;
    const data = await store.loadAll();
    if (!data) return;
    const photos: ProjectBundle['photos'] = {};
    for (const [id, blob] of data.blobs) {
      photos[id] = { mime: blob.type || 'image/jpeg', data: await blobToBase64(blob) };
    }
    const bundle: ProjectBundle = { version: 1, snapshot: data.snapshot, photos };
    triggerDownload('panorama-bundle.json', new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
  })();
});

const loadBundleBtn = getElement('load-bundle');
const loadBundleInput = getElement<HTMLInputElement>('load-bundle-input');
loadBundleBtn.addEventListener('click', () => { loadBundleInput.click(); });
loadBundleInput.addEventListener('change', () => {
  void (async (): Promise<void> => {
    const file = loadBundleInput.files?.[0];
    // Allow re-loading the same file later by clearing the input value.
    loadBundleInput.value = '';
    if (!file || !store) return;
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); }
    catch { alert('Could not parse file as JSON.'); return; }
    if (!isValidBundle(parsed)) { alert('File is not a valid panorama bundle.'); return; }
    if (!confirm('Loading this bundle will replace your current project. Continue?')) return;
    const blobs = new Map<string, Blob>();
    for (const [id, photo] of Object.entries(parsed.photos)) {
      blobs.set(id, base64ToBlob(photo.data, photo.mime));
    }
    await store.replaceAll(parsed.snapshot, blobs);
    window.location.reload();
  })();
});

const clearProjectBtn = getElement('clear-project');
clearProjectBtn.addEventListener('click', () => {
  void (async (): Promise<void> => {
    if (!store) return;
    if (!confirm('This will delete all photos and POIs in this project. Continue?')) return;
    await store.clearAll();
    window.location.reload();
  })();
});

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
    lockCamera: lockCameraEl.checked,
    terrainMode: terrain.getMode(),
    sunDateTime: sunDateTimeEl.value,
    cameraHeight: terrain.getCameraHeight(),
    hazeDensity: hazeSliderToDensity(parseFloat(hazeSliderEl.value)),
    curvatureEnabled: terrain.getCurvatureEnabled(),
    refractionEnabled: terrain.getRefractionEnabled(),
    solvePhotoRoll: solveRollToggleEl.checked,
    overlays: overlaysSnap,
    mapPois: overlays.getMapPOIs().map(m => ({ id: m.id, lat: m.latlng.lat, lng: m.latlng.lng })),
  };
}

function save(): void {
  if (restoring) return; // ignore self-induced saves while replaying
  store?.scheduleSave(getSnapshot);
}

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
  if (snapshot.solvePhotoRoll !== undefined) solveRollToggleEl.checked = snapshot.solvePhotoRoll;
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

  // Restore standalone map-POIs (preserve original ids so save/load is idempotent).
  if (snapshot.mapPois) {
    for (const m of snapshot.mapPois) {
      overlays.restoreMapPOI(m.id, { lat: m.lat, lng: m.lng });
    }
  }

  // Tab last — switching to map triggers Leaflet which needs overlays in
  // place. Map the legacy 'flat' value (when there was a Flat tab) onto '360'.
  viewTabs.setMode(snapshot.tab === 'flat' ? '360' : snapshot.tab);
  restoring = false;
}

applyLocationGate();
hud.refresh();
refreshSelectionUI();
viewer.start();
