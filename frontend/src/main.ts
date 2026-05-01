import * as THREE from 'three';
import { createViewer } from './viewer.js';
import { createOverlayManager, dirFromAzAlt } from './overlay.js';
import { createBaker } from './bake.js';
import { attachInput } from './input.js';
import { createHud, attachViewTabs, attachDownload } from './ui.js';
import { createMapView } from './map.js';
import { createTerrainView } from './terrain.js';
import { createSunMarker } from './sun-marker.js';
import { createControlPointColumns, findHitColumn } from './map-poi-columns.js';
import type { ControlPointColumn } from './map-poi-columns.js';
import { getElement, overlayData } from './types.js';
import type { LatLng } from './types.js';
import * as api from './api.js';
import type { ApiHydratedLocation, ApiLocation } from './api.js';
import { loadPrefs } from './prefs.js';
import { createSyncManager } from './sync.js';
import { createSolverLoop } from './solver-loop.js';
import { createSettingsPanel } from './settings.js';
import { createOrchestration } from './handlers.js';
import { createAdminModal } from './admin-modal.js';
import { createStartProjectModal } from './start-project-modal.js';

// --- URL ↔ project id ---------------------------------------------------

const ID_RE = /^\/([A-Z2-7]{13})$/;
function parseLocationIdFromURL(): string | null {
  const m = ID_RE.exec(location.pathname);
  return m ? m[1]! : null;
}
const currentLocationId: string | null = parseLocationIdFromURL();
const getCurrentLocationId = (): string | null => currentLocationId;

// Index mode (no project in URL) hides the project-scoped chrome — the
// upper-right buttons + tabs only make sense once a project is loaded.
if (currentLocationId === null) getElement('top-right').hidden = true;

// --- Viewer + scene singletons -----------------------------------------

const viewer = createViewer({ container: document.body });

const overlays = createOverlayManager({
  overlaysGroup: viewer.overlaysGroup,
  getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
  // The closure captures sync, solver, settings, mapView — all declared below.
  // Safe because onMutate fires only after bootstrap, by which point every
  // const is bound.
  onMutate: () => {
    viewer.requestRender();
    baker.markDirty();
    if (mapView.isVisible()) refreshMapAnnotations();
    refreshControlPointColumns();
    solver.runSolve();
    sync.flush();
    settings.persist();
  },
  onSelectionChange: () => {
    viewer.requestRender();
    if (mapView.isVisible()) refreshMapAnnotations();
    refreshControlPointColumns();
  },
  onLightMutate: () => {
    viewer.requestRender();
    baker.markDirty();
    sync.flush();
  },
});

const terrain = createTerrainView({
  scene: viewer.scene,
  requestRender: () => { viewer.requestRender(); },
});
const sunMarker = createSunMarker({
  scene: viewer.scene,
  requestRender: () => { viewer.requestRender(); },
});
const cpColumns = createControlPointColumns({
  scene: viewer.scene,
  requestRender: () => { viewer.requestRender(); },
});
const baker = createBaker({
  renderer: viewer.renderer,
  scene: viewer.scene,
  setVisualsVisible: visible => {
    overlays.setVisualsVisible(visible);
    cpColumns.setVisible(visible);
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

// --- Cross-cutting refreshers (need late access to managers) -----------

function refreshMapAnnotations(): void {
  mapView.setOverlayCones(overlays.getCones());
  mapView.setImageMeasurementBearings(overlays.getImageMeasurements());
  mapView.setMapMeasurements(overlays.getMapMeasurements());
}

function refreshControlPointColumns(): void {
  if (viewTabs.getMode() !== '360') return;
  const camLoc = mapView.getLocation();
  const columns: ControlPointColumn[] = [];
  for (const cp of overlays.getControlPoints()) {
    if (cp.estLat === null || cp.estLng === null) continue;
    columns.push({ id: cp.id, anchor: { lat: cp.estLat, lng: cp.estLng }, selected: cp.selected });
  }
  cpColumns.update(camLoc, columns);
}

const coordsEl = getElement('map-coords');
coordsEl.textContent = 'no location set — right-click the map to start a project';

function applyCameraLocation(loc: LatLng): void {
  coordsEl.textContent = `lat ${loc.lat.toFixed(5)}  lng ${loc.lng.toFixed(5)}`;
  terrain.setLocation(loc);
  settings.refreshSunDirection();
  refreshControlPointColumns();
  applyLocationGate();
  // Mark the location dirty so the next flush PUTs it.
  sync.flush();
}

const tab360El = getElement<HTMLButtonElement>('tab-360');
function applyLocationGate(): void {
  const hasLocation = mapView.getLocation() !== null;
  tab360El.disabled = !hasLocation;
  tab360El.title = hasLocation ? '' : 'Set a camera location on the Map first';
  if (!hasLocation && viewTabs.getMode() === '360') viewTabs.setMode('map');
}

// --- Sync, solver, settings, handlers, admin ---------------------------

const sync = createSyncManager({
  overlays,
  getCurrentLocationId,
  getCameraLocation: () => mapView.getLocation(),
});

const solver = createSolverLoop({
  overlays,
  getCameraLocation: () => mapView.getLocation(),
  isSolveRollEnabled: () => settings.isSolveRollEnabled(),
  onCameraMovedBySolver: loc => {
    mapView.setLocation(loc);
    applyCameraLocation(loc);
  },
});

const settings = createSettingsPanel({
  viewer, terrain, sunMarker, hud,
  getCameraLocation: () => mapView.getLocation(),
  getCurrentLocationId,
  getViewTab: () => viewTabs.getMode(),
  refreshMapAnnotationsIfVisible: () => { if (mapView.isVisible()) refreshMapAnnotations(); },
  runSolve: () => { solver.runSolve(); },
  setCameraLocked: locked => { solver.setCameraLocked(locked); },
});

const handlers = createOrchestration({
  getCurrentLocationId,
  overlays,
  sync,
  applyCameraLocation,
  runSolve: () => { solver.runSolve(); },
});

const admin = createAdminModal({ getCurrentLocationId });
const startProjectModal = createStartProjectModal({
  onSubmit: input => handlers.onStartProjectHere(input),
});

// --- Map + input + tabs wiring -----------------------------------------

const addPoiBtnEl = getElement('add-poi');

const mapView = createMapView({
  container: getElement('map'),
  onShowRefresh: () => { refreshMapAnnotations(); },
  onLocationChange: loc => { handlers.onSetLocation(loc); },
  onPOIAnchorClick: (handle, latlng) => { void handlers.onAnchorImageMeasurementByMapClick(handle, latlng); },
  onMapPoiArmedAddClick: latlng => { void handlers.onAddMapMeasurement(latlng); },
  onMapPoiClick: id => { overlays.setSelectedMapMeasurement(id); },
  onMapPoiDragged: (id, latlng) => {
    overlays.withBatch(() => { overlays.setMapMeasurementLatLng(id, latlng); });
  },
  onMapPoiArmedChange: armed => { addPoiBtnEl.classList.toggle('armed', armed); },
  onProjectMarkerOpen: id => { location.assign('/' + id); },
  onProjectMarkerPreview: id => { void showProjectPreview(id); },
  onStartProjectHere: loc => { startProjectModal.open(loc); },
});

const SHIFT_WHEEL_LOG_PER_PX = 0.005;
const COLUMN_NDC_HIT_RADIUS = 0.04;

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
});

const input = attachInput({
  viewer,
  overlays,
  onChange: () => { viewer.requestRender(); hud.refresh(); refreshSelectionUI(); settings.persist(); },
  onPhotoDropped: (tex, blob, aspect, dir, revokeUrl) => {
    void handlers.onPhotoDropped(tex, blob, aspect, dir, revokeUrl);
  },
  onAddImagePOI: (overlay, u, v) => { void handlers.onAddImageMeasurement(overlay, u, v); },
  onMatchImagePOI: (overlay, u, v, controlPointId, latlng) => {
    void handlers.onMatchImageMeasurement(overlay, u, v, controlPointId, latlng);
  },
  onShiftWheel: deltaPx => {
    const h = terrain.getCameraHeight();
    const s = Math.sign(h) * Math.log1p(Math.abs(h)) - deltaPx * SHIFT_WHEEL_LOG_PER_PX;
    const next = Math.sign(s) * Math.expm1(Math.abs(s));
    if (!terrain.setCameraHeight(next)) return;
    hud.refresh();
    settings.persist();
  },
  onPoiArmChange: armed => { addPoiBtnEl.classList.toggle('armed', armed); },
  findColumnAtNDC: ndc => {
    const camLoc = mapView.getLocation();
    if (!camLoc) return null;
    return findHitColumn(ndc, COLUMN_NDC_HIT_RADIUS, viewer.camera, camLoc, overlays.getControlPoints());
  },
  onHoveredColumnChange: id => { cpColumns.setHoveredColumn(id); },
});

addPoiBtnEl.addEventListener('click', () => {
  if (viewTabs.getMode() === '360') input.togglePoiArm();
  else mapView.toggleMapPoiArm();
});

const viewTabs = attachViewTabs({ viewer, hud, mapView });
viewTabs.onModeChange(mode => {
  input.disarmPoi();
  mapView.disarmAll();
  if (mode === '360') refreshControlPointColumns();
  settings.persist();
});

attachDownload({ baker });

// --- Bootstrap ---------------------------------------------------------

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
  sync.registerLocation(loc);
  mapView.setLocation(loc);
  applyCameraLocation(loc);

  const loader = new THREE.TextureLoader();
  await Promise.all(data.photos.map(p => new Promise<void>(resolve => {
    loader.load(api.photoBlobUrl(p.id), tex => {
      const dir = dirFromAzAlt(p.photo_az, p.photo_tilt);
      const o = overlays.addOverlay(tex, p.aspect, dir, { id: p.id });
      // applyPose handles photoAz/photoTilt/photoRoll/sizeRad; setOpacity
      // handles the body material. Together they restore everything that
      // userData carries, without the caller poking userData directly.
      overlays.applyPose(o, {
        photoAz: p.photo_az, photoTilt: p.photo_tilt, photoRoll: p.photo_roll,
        sizeRad: p.size_rad, aspect: p.aspect, camLat: loc.lat, camLng: loc.lng,
      });
      overlays.setOpacity(o, p.opacity);
      sync.registerPhoto(p.id, {
        aspect: p.aspect, photo_az: p.photo_az, photo_tilt: p.photo_tilt,
        photo_roll: p.photo_roll, size_rad: p.size_rad, opacity: p.opacity,
      });
      resolve();
    }, undefined, () => { resolve(); });
  })));

  // Control points first — image measurements pull their anchor cache from
  // the linked CP's est_lat/est_lng.
  const cpAnchorById = new Map<string, LatLng | null>();
  for (const cp of data.control_points) {
    const anchor = (cp.est_lat !== null && cp.est_lng !== null)
      ? { lat: cp.est_lat, lng: cp.est_lng } : null;
    cpAnchorById.set(cp.id, anchor);
    overlays.addControlPoint(cp.id, {
      description: cp.description, estLat: cp.est_lat, estLng: cp.est_lng, estAlt: cp.est_alt,
    });
    sync.registerControlPoint(cp.id, {
      description: cp.description, est_lat: cp.est_lat, est_lng: cp.est_lng, est_alt: cp.est_alt,
    });
  }

  for (const m of data.map_measurements) {
    overlays.addMapMeasurement(m.id, { lat: m.lat, lng: m.lng }, m.control_point_id);
    sync.registerMapMeasurement(m.id, { lat: m.lat, lng: m.lng, control_point_id: m.control_point_id });
  }

  for (const im of data.image_measurements) {
    const overlay = overlays.getOverlayById(im.photo_id);
    if (!overlay) continue;
    const anchor = im.control_point_id ? cpAnchorById.get(im.control_point_id) ?? null : null;
    overlays.addImageMeasurement(overlay, im.u, im.v, {
      id: im.id,
      controlPointId: im.control_point_id,
      controlPointAnchor: anchor,
    });
    sync.registerImageMeasurement(im.id, { u: im.u, v: im.v, control_point_id: im.control_point_id });
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

async function showProjectPreview(id: string): Promise<void> {
  let data: ApiHydratedLocation;
  try {
    data = await api.getLocation(id);
  } catch (err) {
    console.error('preview failed:', err);
    return;
  }
  // size_rad is the photo's horizontal angular subtense (applySize derives
  // plane width = 2·R·tan(sizeRad/2); height = width/aspect). The cone
  // half-angle is sizeRad/2 directly — aspect doesn't enter here.
  const cones = data.photos.map(p => ({
    azL: p.photo_az - p.size_rad / 2,
    azR: p.photo_az + p.size_rad / 2,
  }));
  // Linked CPs: any CP referenced by at least one image measurement, drawn at
  // its est_lat/est_lng. CPs without an estimate are excluded from the dots.
  const linkedCPIds = new Set<string>();
  for (const im of data.image_measurements) {
    if (im.control_point_id !== null) linkedCPIds.add(im.control_point_id);
  }
  const linkedMapPOIs = data.control_points
    .filter(cp => linkedCPIds.has(cp.id) && cp.est_lat !== null && cp.est_lng !== null)
    .map(cp => ({ lat: cp.est_lat!, lng: cp.est_lng! }));
  mapView.setProjectPreview({
    origin: { lat: data.location.lat, lng: data.location.lng },
    cones,
    linkedMapPOIs,
  });
}

async function bootstrap(): Promise<void> {
  if (currentLocationId) {
    await hydrateFromAPI(currentLocationId);
    const prefs = loadPrefs(currentLocationId);
    settings.apply(prefs);
    if (prefs.tab !== undefined) viewTabs.setMode(prefs.tab);
    overlays.setSelected(null);
    overlays.setSelectedImageMeasurement(null);
    overlays.setSelectedMapMeasurement(null);
    admin.setVisible(true);
  } else {
    void showProjectMarkers();
  }
  sync.markLoaded();
  applyLocationGate();
  hud.refresh();
  refreshSelectionUI();
  viewer.start();
}

void bootstrap();
