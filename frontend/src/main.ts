import * as THREE from 'three';
import { createViewer, HAZE_DENSITY_MAX } from './viewer.js';
import { createOverlayManager, DEFAULT_SIZE_RAD } from './overlay.js';
import { createBaker } from './bake.js';
import { attachInput } from './input.js';
import { createHud, attachViewTabs, attachDownload } from './ui.js';
import { createMapView } from './map.js';
import { solveJointPose, autoLocalFreeParams } from './solver.js';
import { dirFromAzAlt } from './overlay.js';
import { getElement, meshMat, overlayData, poiData } from './types.js';
import type { JointPhoto, LatLng, SolverParam } from './types.js';
import { createTerrainView } from './terrain.js';
import type { TerrainMode } from './terrain.js';
import { solarAzAlt } from './solar.js';
import { createSunMarker } from './sun-marker.js';
import { createMapPoiColumns, COLUMN_Y_MIN_M, COLUMN_Y_MAX_M } from './map-poi-columns.js';
import type { MapPoiColumn } from './map-poi-columns.js';
import { latLngToCameraRelativeMeters } from './geo.js';
import * as api from './api.js';
import type { ApiHydratedLocation, ApiLocation } from './api.js';
import { loadPrefs, savePrefs } from './prefs.js';
import type { Prefs } from './prefs.js';

// --- URL ↔ project id ---------------------------------------------------

const ID_RE = /^\/([A-Z2-7]{13})$/;
function parseLocationIdFromURL(): string | null {
  const m = ID_RE.exec(location.pathname);
  return m ? m[1]! : null;
}

const currentLocationId: string | null = parseLocationIdFromURL();

// --- Sync state ---------------------------------------------------------

interface SyncedLocation { lat: number; lng: number }
interface SyncedPhoto { photo_az: number; photo_tilt: number; photo_roll: number; size_rad: number; opacity: number; aspect: number }
interface SyncedMapPOI { lat: number; lng: number }
interface SyncedImagePOI { u: number; v: number; map_poi_id: string | null }

const synced = {
  location: null as SyncedLocation | null,
  photos: new Map<string, SyncedPhoto>(),
  mapPois: new Map<string, SyncedMapPOI>(),
  imagePois: new Map<string, SyncedImagePOI>(),
};

// While `loading` is true, onMutate skips the diff — initial scene
// reconstruction would otherwise look like a flood of new entities to sync.
let loading = true;
// Re-entrancy / concurrency guard: at most one flushSync runs at a time.
let flushing = false;
let flushPending = false;

const viewer = createViewer({ container: document.body });

let isSolving = false;
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
    if (mapView.isVisible()) refreshMapAnnotations();
    refreshMapPoiColumns();
    runSolve();
    if (!loading) void flushSync();
    persistPrefs();
  },
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
  if (viewTabs.getMode() !== '360') return;
  const camLoc = mapView.getLocation();
  const columns: MapPoiColumn[] = [];
  for (const p of overlays.getPOIs()) {
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
coordsEl.textContent = 'no location set — right-click the map to start a project';

function applyCameraLocation(loc: LatLng): void {
  coordsEl.textContent = `lat ${loc.lat.toFixed(5)}  lng ${loc.lng.toFixed(5)}`;
  terrain.setLocation(loc);
  refreshSunDirection();
  refreshMapPoiColumns();
  applyLocationGate();
  // Mark the location dirty so the next flush PUTs it.
  if (!loading && currentLocationId) void flushSync();
}

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
  viewer.requestRender();
  if (mapView.isVisible()) refreshMapAnnotations();
  hud.refresh();
  persistPrefs();
});

const terrainModeEl = getElement<HTMLSelectElement>('terrain-mode');
const sunDateTimeEl = getElement<HTMLInputElement>('sun-datetime');
sunDateTimeEl.value = formatLocalDateTime(new Date());

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function formatLocalDateTime(d: Date): string {
  return `${d.getFullYear().toString()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function refreshSunDirection(): void {
  const camLoc = mapView.getLocation();
  if (!camLoc || !sunDateTimeEl.value) return;
  const date = new Date(sunDateTimeEl.value);
  if (Number.isNaN(date.getTime())) return;
  const { az, alt } = solarAzAlt(date, camLoc.lat, camLoc.lng);
  terrain.setSunDirection(az, alt);
  sunMarker.setDirection(az, alt);
}

terrainModeEl.addEventListener('change', () => {
  terrain.setMode(terrainModeEl.value as TerrainMode);
  persistPrefs();
});
sunDateTimeEl.addEventListener('change', () => {
  refreshSunDirection();
  persistPrefs();
});

const settingsBtnEl = getElement<HTMLButtonElement>('settings-btn');
const settingsPanelEl = getElement('settings-panel');
settingsBtnEl.addEventListener('click', () => {
  settingsPanelEl.hidden = !settingsPanelEl.hidden;
  settingsBtnEl.setAttribute('aria-expanded', String(!settingsPanelEl.hidden));
});

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
  persistPrefs();
});

const curvatureToggleEl = getElement<HTMLInputElement>('curvature-toggle');
const refractionToggleEl = getElement<HTMLInputElement>('refraction-toggle');
function refreshRefractionAvailability(): void {
  refractionToggleEl.disabled = !curvatureToggleEl.checked;
}
curvatureToggleEl.addEventListener('change', () => {
  terrain.setCurvatureEnabled(curvatureToggleEl.checked);
  refreshRefractionAvailability();
  persistPrefs();
});
refractionToggleEl.addEventListener('change', () => {
  terrain.setRefractionEnabled(refractionToggleEl.checked);
  persistPrefs();
});
refreshRefractionAvailability();

const solveRollToggleEl = getElement<HTMLInputElement>('solve-roll-toggle');
solveRollToggleEl.addEventListener('change', () => {
  runSolve();
  persistPrefs();
});

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

  const totalPois = entries.reduce((s, e) => s + e.photo.pois.length, 0);
  const localUnknowns = entries.reduce((s, e) => s + e.photo.free.length, 0);
  const cameraLocked = lockedParams.has('camLat') || lockedParams.has('camLng');
  const solveCamera = !cameraLocked && totalPois >= localUnknowns + 2;

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
  if (proposed.camLoc) {
    mapView.setLocation(proposed.camLoc);
    applyCameraLocation(proposed.camLoc);
  }
}

const addPoiBtnEl = getElement('add-poi');

const mapView = createMapView({
  container: getElement('map'),
  onShowRefresh: () => { refreshMapAnnotations(); },
  onLocationChange: loc => {
    void handleSetLocation(loc);
  },
  onPOIAnchorClick: (handle, latlng) => {
    void handleAnchorImagePOIByMapClick(handle, latlng);
  },
  onPOIAnchorDragged: (handle, latlng) => {
    void handleAnchorImagePOIByMapClick(handle, latlng);
  },
  onPOIAnchorMarkerClick: handle => { overlays.setSelectedPOI(handle); },
  onMapPoiArmedAddClick: latlng => {
    void handleAddMapPOI(latlng);
  },
  onMapPoiClick: id => { overlays.setSelectedMapPOI(id); },
  onMapPoiDragged: (id, latlng) => {
    overlays.withBatch(() => { overlays.setMapPOILatLng(id, latlng); });
  },
  onMapPoiArmedChange: armed => { addPoiBtnEl.classList.toggle('armed', armed); },
  onProjectMarkerOpen: id => { location.assign('/' + id); },
  onStartProjectHere: loc => { void handleStartProjectHere(loc); },
});

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
  if (!loading) void flushSync();
});

const COLUMN_NDC_HIT_RADIUS = 0.04;
const _baseProjected = new THREE.Vector3();
const _topProjected = new THREE.Vector3();
function ndcSegmentDistance(p: { x: number; y: number }, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / lenSq)) : 0;
  return Math.hypot(apx - t * abx, apy - t * aby);
}
function findColumnAtNDC(ndc: { x: number; y: number }): { id: string; latlng: LatLng } | null {
  const camLoc = mapView.getLocation();
  if (!camLoc) return null;
  let best: { id: string; latlng: LatLng } | null = null;
  let bestDist = COLUMN_NDC_HIT_RADIUS;
  for (const m of overlays.getMapPOIs()) {
    const { x, z } = latLngToCameraRelativeMeters(m.latlng, camLoc);
    _baseProjected.set(x, COLUMN_Y_MIN_M, z).project(viewer.camera);
    _topProjected.set(x, COLUMN_Y_MAX_M, z).project(viewer.camera);
    if (_baseProjected.z > 1 && _topProjected.z > 1) continue;
    const d = ndcSegmentDistance(ndc, _baseProjected, _topProjected);
    if (d < bestDist) { bestDist = d; best = { id: m.id, latlng: m.latlng }; }
  }
  return best;
}

const input = attachInput({
  viewer,
  overlays,
  onChange: () => { viewer.requestRender(); hud.refresh(); refreshSelectionUI(); persistPrefs(); },
  onPhotoDropped: (tex, blob, aspect, dir, revokeUrl) => {
    void handlePhotoDropped(tex, blob, aspect, dir, revokeUrl);
  },
  onAddImagePOI: (overlay, u, v) => {
    void handleAddImagePOI(overlay, u, v, null, null);
  },
  onMatchImagePOI: (overlay, u, v, mapPOIId, latlng) => {
    void handleAddImagePOI(overlay, u, v, mapPOIId, latlng);
  },
  onShiftWheel: deltaPx => {
    const h = terrain.getCameraHeight();
    const s = Math.sign(h) * Math.log1p(Math.abs(h)) - deltaPx * SHIFT_WHEEL_LOG_PER_PX;
    const next = Math.sign(s) * Math.expm1(Math.abs(s));
    if (!terrain.setCameraHeight(next)) return;
    hud.refresh();
    persistPrefs();
  },
  onPoiArmChange: armed => { addPoiBtnEl.classList.toggle('armed', armed); },
  findColumnAtNDC,
  onHoveredColumnChange: id => { mapPoiColumns.setHoveredColumn(id); },
});
addPoiBtnEl.addEventListener('click', () => {
  if (viewTabs.getMode() === '360') input.togglePoiArm();
  else mapView.toggleMapPoiArm();
});
const viewTabs = attachViewTabs({ viewer, hud, mapView });
viewTabs.onModeChange(mode => {
  input.disarmPoi();
  mapView.disarmAll();
  if (mode === '360') refreshMapPoiColumns();
  persistPrefs();
});

const tab360El = getElement<HTMLButtonElement>('tab-360');
function applyLocationGate(): void {
  const hasLocation = mapView.getLocation() !== null;
  tab360El.disabled = !hasLocation;
  tab360El.title = hasLocation ? '' : 'Set a camera location on the Map first';
  if (!hasLocation && viewTabs.getMode() === '360') viewTabs.setMode('map');
}
attachDownload({ baker });

// --- Admin modal -------------------------------------------------------

const adminBtn = getElement<HTMLButtonElement>('admin-btn');
const adminModal = getElement('admin-modal');
const adminCloseBtn = getElement<HTMLButtonElement>('admin-close');
const adminDeleteBtn = getElement<HTMLButtonElement>('admin-delete');
function openAdminModal(): void { adminModal.hidden = false; }
function closeAdminModal(): void { adminModal.hidden = true; }
adminBtn.addEventListener('click', openAdminModal);
adminCloseBtn.addEventListener('click', closeAdminModal);
adminModal.addEventListener('click', e => {
  if (e.target === adminModal) closeAdminModal();
});
adminDeleteBtn.addEventListener('click', () => {
  if (!currentLocationId) return;
  if (!confirm('Delete this project? Photos, POIs, and matches will be removed permanently.')) return;
  adminDeleteBtn.disabled = true;
  void api.deleteLocation(currentLocationId)
    .then(() => { location.assign('/'); })
    .catch((err: unknown) => {
      adminDeleteBtn.disabled = false;
      console.error('delete project failed:', err);
      alert('Could not delete the project.');
    });
});

// --- Orchestration: creates always go through the API, then mutate scene ---

async function handleSetLocation(loc: LatLng): Promise<void> {
  if (!currentLocationId) return;
  synced.location = { lat: loc.lat, lng: loc.lng };
  await api.updateLocation(currentLocationId, loc);
  applyCameraLocation(loc);
  runSolve();
}

async function handleStartProjectHere(loc: LatLng): Promise<void> {
  const created = await api.createLocation(loc);
  // Hard navigate so the new project hydrates from a clean state, regardless
  // of whether we were on / or some other /<id>.
  location.assign('/' + created.id);
}

async function handlePhotoDropped(
  tex: THREE.Texture, blob: Blob, aspect: number, dir: THREE.Vector3, revokeUrl: () => void,
): Promise<void> {
  if (!currentLocationId) {
    revokeUrl();
    alert('Set a camera location before dropping photos.');
    return;
  }
  // Recover az/alt from the placement direction.
  const az = Math.atan2(-dir.x, -dir.z);
  const alt = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  try {
    const photo = await api.createPhoto(currentLocationId, {
      aspect, photo_az: az, photo_tilt: alt, photo_roll: 0, size_rad: DEFAULT_SIZE_RAD, opacity: 1,
    });
    await api.uploadPhotoBlob(photo.id, blob);
    // Pre-register so the diff after addOverlay is a no-op for this create.
    synced.photos.set(photo.id, {
      aspect, photo_az: az, photo_tilt: alt, photo_roll: 0, size_rad: DEFAULT_SIZE_RAD, opacity: 1,
    });
    overlays.addOverlay(tex, aspect, dir, { id: photo.id });
  } finally {
    revokeUrl();
  }
}

async function handleAddImagePOI(
  overlay: THREE.Group, u: number, v: number, mapPOIId: string | null, latlng: LatLng | null,
): Promise<void> {
  const photoId = overlayData(overlay).id;
  const created = await api.createImagePOI(photoId, { u, v, map_poi_id: mapPOIId });
  synced.imagePois.set(created.id, { u, v, map_poi_id: mapPOIId });
  overlays.addPOI(overlay, u, v, { id: created.id, mapPOIId, mapAnchor: latlng });
  if (mapPOIId !== null) {
    overlays.setSelectedPair(getPOIByImageId(created.id), mapPOIId);
  }
}

async function handleAddMapPOI(latlng: LatLng): Promise<void> {
  if (!currentLocationId) return;
  const created = await api.createMapPOI(currentLocationId, latlng);
  synced.mapPois.set(created.id, { lat: latlng.lat, lng: latlng.lng });
  overlays.addMapPOI(created.id, latlng);
}

async function handleAnchorImagePOIByMapClick(handle: THREE.Mesh, latlng: LatLng): Promise<void> {
  if (!currentLocationId) return;
  const pd = poiData(handle);
  // Bearing-ray click / anchor-marker drag both update the *linked* map POI.
  // If the image POI is already linked, move that map POI in place — note
  // this also moves any other image POIs sharing the same map POI, which is
  // the intended behavior of the FK model: a landmark is shared.
  if (pd.mapPOIId) {
    overlays.withBatch(() => { overlays.setMapPOILatLng(pd.mapPOIId!, latlng); });
    return;
  }
  // Unlinked: create a fresh map POI at the click latlng and bind this image
  // POI to it.
  const newMapPOI = await api.createMapPOI(currentLocationId, latlng);
  synced.mapPois.set(newMapPOI.id, { lat: latlng.lat, lng: latlng.lng });
  overlays.addMapPOI(newMapPOI.id, latlng);
  overlays.setPOIMapAnchor(handle, latlng, newMapPOI.id);
}

function getPOIByImageId(id: string): THREE.Mesh | null {
  for (const child of viewer.overlaysGroup.children) {
    const data = overlayData(child as THREE.Group);
    if (!data.pois) continue;
    for (const p of data.pois) {
      if (poiData(p).id === id) return p;
    }
  }
  return null;
}

// --- Snapshots + sync (diff against `synced` on every onMutate) ---------

function buildCurrentPhoto(o: THREE.Group): SyncedPhoto {
  const data = overlayData(o);
  // camLoc isn't part of the per-photo sync payload — pass null to skip the lookup.
  const pose = overlays.extractPose(o, null);
  return {
    aspect: pose.aspect,
    photo_az: pose.photoAz,
    photo_tilt: pose.photoTilt,
    photo_roll: pose.photoRoll,
    size_rad: pose.sizeRad,
    opacity: meshMat(data.body).opacity,
  };
}

// Generic three-way diff between a current snapshot and a cached one. Walks
// `current` and queues create/update tasks for new and changed entries; then
// queues deletes for cached entries no longer in `current`. Mutates `cached`
// to mirror `current` when it returns.
function syncResource<T>(
  current: Map<string, T>,
  cached: Map<string, T>,
  equal: (a: T, b: T) => boolean,
  onCreate: ((id: string, val: T) => Promise<unknown>) | null,
  onUpdate: (id: string, val: T) => Promise<unknown>,
  onDelete: (id: string) => Promise<unknown>,
  tasks: Promise<unknown>[],
): void {
  for (const [id, val] of current) {
    const last = cached.get(id);
    if (!last) {
      cached.set(id, val);
      // onCreate is null for resources whose creates always go through an
      // explicit handler (e.g., image POIs). A diff-detected new entity for
      // such a resource means a bug in the orchestration layer; skip silently
      // here and let the explicit-create path own the POST.
      if (onCreate) tasks.push(onCreate(id, val));
    } else if (!equal(val, last)) {
      cached.set(id, val);
      tasks.push(onUpdate(id, val));
    }
  }
  for (const id of cached.keys()) {
    if (!current.has(id)) {
      cached.delete(id);
      tasks.push(onDelete(id));
    }
  }
}

function photosEqual(a: SyncedPhoto, b: SyncedPhoto): boolean {
  return a.aspect === b.aspect && a.photo_az === b.photo_az && a.photo_tilt === b.photo_tilt
    && a.photo_roll === b.photo_roll && a.size_rad === b.size_rad && a.opacity === b.opacity;
}

function mapPOIsEqual(a: SyncedMapPOI, b: SyncedMapPOI): boolean {
  return a.lat === b.lat && a.lng === b.lng;
}

function imagePOIsEqual(a: SyncedImagePOI, b: SyncedImagePOI): boolean {
  return a.u === b.u && a.v === b.v && a.map_poi_id === b.map_poi_id;
}

async function flushSync(): Promise<void> {
  if (flushing) { flushPending = true; return; }
  flushing = true;
  try {
    flushPending = true;
    while (flushPending) {
      flushPending = false;
      await flushOnce();
    }
  } finally {
    flushing = false;
  }
}

async function flushOnce(): Promise<void> {
  if (!currentLocationId) return;
  // Local non-null binding so closures don't lose the narrowing.
  const locId = currentLocationId;
  const tasks: Promise<unknown>[] = [];

  // Location PUT.
  const camLoc = mapView.getLocation();
  if (camLoc && (synced.location?.lat !== camLoc.lat || synced.location.lng !== camLoc.lng)) {
    synced.location = { lat: camLoc.lat, lng: camLoc.lng };
    tasks.push(api.updateLocation(locId, camLoc));
  }

  // Build current snapshots for each resource type.
  const currentPhotos = new Map<string, SyncedPhoto>();
  for (const child of viewer.overlaysGroup.children) {
    const o = child as THREE.Group;
    currentPhotos.set(overlayData(o).id, buildCurrentPhoto(o));
  }
  const currentMapPois = new Map<string, SyncedMapPOI>();
  for (const m of overlays.getMapPOIs()) {
    currentMapPois.set(m.id, { lat: m.latlng.lat, lng: m.latlng.lng });
  }
  const currentImagePois = new Map<string, SyncedImagePOI>();
  for (const p of overlays.getPOIs()) {
    currentImagePois.set(p.id, { u: p.uv.u, v: p.uv.v, map_poi_id: p.mapPOIId });
  }

  syncResource(currentPhotos, synced.photos, photosEqual,
    (_id, val) => api.createPhoto(locId, val),
    (id, val) => api.updatePhoto(id, val),
    api.deletePhoto, tasks);
  syncResource(currentMapPois, synced.mapPois, mapPOIsEqual,
    (_id, val) => api.createMapPOI(locId, val),
    (id, val) => api.updateMapPOI(id, val),
    api.deleteMapPOI, tasks);
  // Image POIs are always created via the explicit handler (handleAddImagePOI),
  // never from the diff — pass null for onCreate.
  syncResource(currentImagePois, synced.imagePois, imagePOIsEqual,
    null,
    (id, val) => api.updateImagePOI(id, val),
    api.deleteImagePOI, tasks);

  if (tasks.length > 0) await Promise.all(tasks);
}

// --- Prefs (per-location view state in localStorage) --------------------

function persistPrefs(): void {
  if (!currentLocationId || loading) return;
  const { azimuth, altitude } = viewer.getAzAlt();
  const prefs: Prefs = {
    azimuth, altitude,
    fov: viewer.camera.fov,
    tab: viewTabs.getMode(),
    lockCamera: lockCameraEl.checked,
    solvePhotoRoll: solveRollToggleEl.checked,
    terrainMode: terrain.getMode(),
    sunDateTime: sunDateTimeEl.value,
    cameraHeight: terrain.getCameraHeight(),
    hazeDensity: hazeSliderToDensity(parseFloat(hazeSliderEl.value)),
    curvatureEnabled: terrain.getCurvatureEnabled(),
    refractionEnabled: terrain.getRefractionEnabled(),
  };
  savePrefs(currentLocationId, prefs);
}

function applyPrefs(p: Partial<Prefs>): void {
  if (p.azimuth !== undefined && p.altitude !== undefined) viewer.setAzAlt(p.azimuth, p.altitude);
  if (p.fov !== undefined) viewer.setFov(p.fov);
  if (p.lockCamera !== undefined) {
    lockCameraEl.checked = p.lockCamera;
    applyCameraLock(p.lockCamera);
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

// --- Bootstrap ----------------------------------------------------------

async function hydrateFromAPI(id: string): Promise<void> {
  let data: ApiHydratedLocation;
  try {
    data = await api.getLocation(id);
  } catch (err) {
    console.error('hydrate failed:', err);
    alert('Could not load this project.');
    return;
  }
  const loc: LatLng = { lat: data.location.lat, lng: data.location.lng };
  synced.location = { lat: loc.lat, lng: loc.lng };
  mapView.setLocation(loc);
  applyCameraLocation(loc);

  const loader = new THREE.TextureLoader();
  await Promise.all(data.photos.map(p => new Promise<void>(resolve => {
    loader.load(api.photoBlobUrl(p.id), tex => {
      const dir = dirFromAzAlt(p.photo_az, p.photo_tilt);
      overlays.addOverlay(tex, p.aspect, dir, { id: p.id });
      // Apply pose fields not derived from dir, plus opacity.
      const list = viewer.overlaysGroup.children;
      const o = list[list.length - 1] as THREE.Group;
      const data = overlayData(o);
      data.sizeRad = p.size_rad;
      data.photoRoll = p.photo_roll;
      meshMat(data.body).opacity = p.opacity;
      // Re-place with the correct roll and re-apply size to scale handles/POIs.
      // applyPose gives a clean re-place that respects roll.
      overlays.applyPose(o, {
        photoAz: p.photo_az, photoTilt: p.photo_tilt, photoRoll: p.photo_roll,
        sizeRad: p.size_rad, aspect: p.aspect, camLat: loc.lat, camLng: loc.lng,
      });
      synced.photos.set(p.id, {
        aspect: p.aspect, photo_az: p.photo_az, photo_tilt: p.photo_tilt,
        photo_roll: p.photo_roll, size_rad: p.size_rad, opacity: p.opacity,
      });
      resolve();
    }, undefined, () => { resolve(); });
  })));

  // Add map POIs first so image POIs can resolve their cached anchors.
  const mapPoiByID = new Map<string, LatLng>();
  for (const m of data.map_pois) {
    mapPoiByID.set(m.id, { lat: m.lat, lng: m.lng });
    overlays.addMapPOI(m.id, { lat: m.lat, lng: m.lng });
    synced.mapPois.set(m.id, { lat: m.lat, lng: m.lng });
  }

  for (const ip of data.image_pois) {
    const overlay = viewer.overlaysGroup.children.find(c => overlayData(c as THREE.Group).id === ip.photo_id) as THREE.Group | undefined;
    if (!overlay) continue;
    const anchor = ip.map_poi_id ? mapPoiByID.get(ip.map_poi_id) ?? null : null;
    overlays.addPOI(overlay, ip.u, ip.v, {
      id: ip.id,
      mapPOIId: ip.map_poi_id,
      mapAnchor: anchor,
    });
    synced.imagePois.set(ip.id, { u: ip.u, v: ip.v, map_poi_id: ip.map_poi_id });
  }
}

async function showProjectMarkers(): Promise<void> {
  let locations: ApiLocation[];
  try {
    locations = await api.listLocations();
  } catch (err) {
    console.error('list locations failed:', err);
    return;
  }
  mapView.setProjectMarkers(locations.map(loc => ({
    id: loc.id,
    latlng: { lat: loc.lat, lng: loc.lng },
    label: loc.name ?? `Untitled ${loc.id.slice(0, 6)}`,
  })));
}

async function bootstrap(): Promise<void> {
  if (currentLocationId) {
    await hydrateFromAPI(currentLocationId);
    const prefs = loadPrefs(currentLocationId);
    applyPrefs(prefs);
    if (prefs.tab !== undefined) viewTabs.setMode(prefs.tab);
    overlays.setSelected(null);
    overlays.setSelectedPOI(null);
    overlays.setSelectedMapPOI(null);
    adminBtn.hidden = false;
  } else {
    void showProjectMarkers();
  }
  loading = false;
  applyLocationGate();
  hud.refresh();
  refreshSelectionUI();
  viewer.start();
  // Selection of any kind shouldn't carry through reload — start clean.
}

void bootstrap();
