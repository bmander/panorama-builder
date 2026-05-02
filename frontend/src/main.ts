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
import { cpHref, FOCUS_QUERY_PARAM, getElement, INDEX_CP_QUERY_PARAM, overlayData, poiData, stationHref } from './types.js';
import { vecToAzAlt } from './geo.js';
import type { LatLng } from './types.js';
import * as api from './api.js';
import type { ApiControlPoint, ApiHydratedStation, ApiStation } from './api.js';
import { loadPrefs } from './prefs.js';
import { createSyncManager } from './sync.js';
import { createSolverLoop } from './solver-loop.js';
import { createSettingsPanel } from './settings.js';
import { createOrchestration } from './handlers.js';
import { createAdminModal } from './admin-modal.js';
import { createStartStationModal } from './start-station-modal.js';
import { createContextMenu } from './context-menu.js';
import { createObservationModal } from './observation-modal.js';
import { solveControlPointLocation } from './cp-location-solver.js';

// --- URL ↔ station id ---------------------------------------------------

const ID_RE = /^\/station\/([A-Z2-7]{13})$/;
function parseStationIdFromURL(): string | null {
  const m = ID_RE.exec(location.pathname);
  return m ? m[1]! : null;
}
const currentStationId: string | null = parseStationIdFromURL();
const getCurrentStationId = (): string | null => currentStationId;

const FOCUS_RE = /^[A-Z2-7]{13}$/;
const focusImageMeasurementId: string | null = (() => {
  const id = new URLSearchParams(location.search).get(FOCUS_QUERY_PARAM);
  return id && FOCUS_RE.test(id) ? id : null;
})();
const focusIndexControlPointId: string | null = (() => {
  const id = new URLSearchParams(location.search).get(INDEX_CP_QUERY_PARAM);
  return id && FOCUS_RE.test(id) ? id : null;
})();

// Index mode (no station in URL) hides the station-scoped chrome — the
// upper-right buttons + tabs only make sense once a station is loaded.
if (currentStationId === null) {
  getElement('top-right').hidden = true;
  getElement('map-coords').hidden = true;
}

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
  // Only show columns for CPs the user is actually observing in this station.
  const observed = new Set<string>();
  for (const im of overlays.getImageMeasurements()) {
    if (im.controlPointId) observed.add(im.controlPointId);
  }
  const columns: ControlPointColumn[] = [];
  for (const cp of overlays.getControlPoints()) {
    if (cp.estLat === null || cp.estLng === null) continue;
    if (!observed.has(cp.id)) continue;
    columns.push({ id: cp.id, anchor: { lat: cp.estLat, lng: cp.estLng }, selected: cp.selected });
  }
  cpColumns.update(camLoc, columns);
}

const coordsEl = getElement('map-coords');

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

function registerControlPoint(cp: ApiControlPoint): void {
  if (overlays.getControlPointById(cp.id) !== null) return;
  overlays.addControlPoint(cp.id, {
    description: cp.description, estLat: cp.est_lat, estLng: cp.est_lng, estAlt: cp.est_alt,
  });
  sync.registerControlPoint(cp.id, {
    description: cp.description, est_lat: cp.est_lat, est_lng: cp.est_lng, est_alt: cp.est_alt,
    started_at: cp.started_at, ended_at: cp.ended_at,
  });
}

function syncControlPoint(cp: ApiControlPoint): void {
  sync.registerControlPoint(cp.id, {
    description: cp.description, est_lat: cp.est_lat, est_lng: cp.est_lng, est_alt: cp.est_alt,
    started_at: cp.started_at, ended_at: cp.ended_at,
  });
  if (overlays.getControlPointById(cp.id) === null) {
    overlays.addControlPoint(cp.id, {
      description: cp.description, estLat: cp.est_lat, estLng: cp.est_lng, estAlt: cp.est_alt,
    });
    return;
  }
  overlays.withBatch(() => {
    overlays.setControlPointDescription(cp.id, cp.description);
    overlays.setControlPointEst(
      cp.id,
      cp.est_lat === null || cp.est_lng === null ? null : { lat: cp.est_lat, lng: cp.est_lng },
    );
  });
}

// --- Sync, solver, settings, handlers, admin ---------------------------

const sync = createSyncManager({
  overlays,
  getCurrentStationId,
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
  getCurrentStationId,
  getViewTab: () => viewTabs.getMode(),
  refreshMapAnnotationsIfVisible: () => { if (mapView.isVisible()) refreshMapAnnotations(); },
  runSolve: () => { solver.runSolve(); },
  setCameraLocked: locked => { solver.setCameraLocked(locked); },
});

const handlers = createOrchestration({
  getCurrentStationId,
  overlays,
  sync,
  applyCameraLocation,
  runSolve: () => { solver.runSolve(); },
});

const admin = createAdminModal({ getCurrentStationId });
const startStationModal = createStartStationModal({
  onSubmit: input => handlers.onStartStationHere(input),
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
  onStationMarkerOpen: id => { location.assign(stationHref(id)); },
  onStationMarkerPreview: id => { void showStationPreview(id); },
  onStartStationHere: loc => { startStationModal.open(loc); },
  onAddControlPointHere: loc => { observationModal.openForMap(loc); },
  onControlPointSolveLocation: id => { void solveAndPersistControlPointLocation(id); },
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

const contextMenu = createContextMenu();
const observationModal = createObservationModal({
  getControlPoints: () => overlays.getControlPoints(),
  onPickExisting: (overlay, u, v, controlPointId) => {
    void handlers.onMatchImageMeasurement(overlay, u, v, controlPointId);
  },
  onCreateAndObserve: (overlay, u, v, description) =>
    handlers.onCreateCPAndObserve(overlay, u, v, description),
  onCreateMapAndObserve: async (latlng, description) => {
    await handlers.onCreateCPAndMapObserve(latlng, description);
    // The new CP needs to appear immediately on the index map.
    if (currentStationId === null) refreshIndexControlPoints();
  },
});

const input = attachInput({
  viewer,
  overlays,
  onChange: () => { viewer.requestRender(); hud.refresh(); refreshSelectionUI(); settings.persist(); },
  onPhotoDropped: (tex, blob, aspect, dir, revokeUrl) => {
    void handlers.onPhotoDropped(tex, blob, aspect, dir, revokeUrl);
  },
  onAddImagePOI: (overlay, u, v) => { void handlers.onAddImageMeasurement(overlay, u, v); },
  onMatchImagePOI: (overlay, u, v, controlPointId) => {
    void handlers.onMatchImageMeasurement(overlay, u, v, controlPointId);
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
  onPhotoBodyContextMenu: (overlay, u, v, sx, sy) => {
    contextMenu.open(sx, sy, [
      { label: 'Add observation here', onClick: () => { observationModal.open(overlay, u, v); } },
    ]);
  },
  onImagePOIContextMenu: (poi, sx, sy) => {
    const cpId = poiData(poi).controlPointId;
    if (!cpId) return;
    contextMenu.open(sx, sy, [
      { label: 'View control point →', onClick: () => { location.assign(cpHref(cpId)); } },
    ]);
  },
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
  let data: ApiHydratedStation;
  try {
    data = await api.getStation(id);
  } catch (err) {
    console.error('hydrate failed:', err);
    alert('Could not load this station.');
    return;
  }
  const loc: LatLng = { lat: data.station.lat, lng: data.station.lng };
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

  // Control points first so subsequent measurement adds reference an existing CP entry.
  for (const cp of data.control_points) {
    registerControlPoint(cp);
  }

  try {
    const cps = await api.listControlPoints();
    for (const cp of cps) registerControlPoint(cp);
  } catch (err) {
    console.error('list control points failed:', err);
  }

  for (const im of data.image_measurements) {
    const overlay = overlays.getOverlayById(im.photo_id);
    if (!overlay) continue;
    overlays.addImageMeasurement(overlay, im.u, im.v, {
      id: im.id,
      controlPointId: im.control_point_id,
    });
    sync.registerImageMeasurement(im.id, { u: im.u, v: im.v, control_point_id: im.control_point_id });
  }
}

async function showStationMarkers(): Promise<void> {
  let stations: ApiStation[];
  try {
    stations = await api.listStations();
  } catch (err) {
    console.error('list stations failed:', err);
    return;
  }
  mapView.setStationMarkers(stations.map(st => ({
    id: st.id,
    latlng: { lat: st.lat, lng: st.lng },
    label: st.name ?? `Untitled ${st.id.slice(0, 6)}`,
  })));
}

async function loadMapMeasurements(): Promise<void> {
  let mms;
  try {
    mms = await api.listMapMeasurements();
  } catch (err) {
    console.error('list map measurements failed:', err);
    return;
  }
  const known = new Set(overlays.getMapMeasurements().map(m => m.id));
  for (const m of mms) {
    if (known.has(m.id)) continue;
    overlays.addMapMeasurement(m.id, { lat: m.lat, lng: m.lng }, m.control_point_id);
    sync.registerMapMeasurement(m.id, {
      lat: m.lat, lng: m.lng, control_point_id: m.control_point_id,
    });
  }
}

function refreshIndexControlPoints(): void {
  const dots = [];
  for (const cp of overlays.getControlPoints()) {
    if (cp.estLat === null || cp.estLng === null) continue;
    dots.push({
      id: cp.id,
      latlng: { lat: cp.estLat, lng: cp.estLng },
      description: cp.description,
    });
  }
  mapView.setIndexControlPoints(dots);
}

async function showIndexControlPoints(): Promise<void> {
  try {
    const cps = await api.listControlPoints();
    for (const cp of cps) registerControlPoint(cp);
  } catch (err) {
    console.error('list control points failed:', err);
  }
  refreshIndexControlPoints();
}

async function solveAndPersistControlPointLocation(id: string): Promise<void> {
  let cp: ApiControlPoint;
  let obs: api.ApiControlPointObservations;
  try {
    [cp, obs] = await Promise.all([
      api.getControlPoint(id),
      api.listControlPointObservations(id),
    ]);
  } catch (err) {
    sync.reportError('load control point observations', err);
    return;
  }

  const result = solveControlPointLocation(cp, obs);
  if (!result) {
    sync.reportError('solve control point location', new Error('not enough observations'));
    return;
  }

  let updated: ApiControlPoint;
  try {
    updated = await api.updateControlPoint(id, {
      description: cp.description,
      est_lat: result.latlng.lat,
      est_lng: result.latlng.lng,
      est_alt: cp.est_alt,
      started_at: cp.started_at,
      ended_at: cp.ended_at,
    });
  } catch (err) {
    sync.reportError('save solved control point location', err);
    return;
  }

  syncControlPoint(updated);
  if (!currentStationId) void showIndexControlPoints();
}

async function showStationPreview(id: string): Promise<void> {
  let data: ApiHydratedStation;
  try {
    data = await api.getStation(id);
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
  // Map.ts only colors CPs that appear in the index layer (those with
  // est_lat/lng), so unestimated CPs in the set are silently ignored.
  const observedCpIds = new Set<string>();
  for (const im of data.image_measurements) {
    if (im.control_point_id !== null) observedCpIds.add(im.control_point_id);
  }
  mapView.setStationPreview({
    origin: { lat: data.station.lat, lng: data.station.lng },
    cones,
    observedCpIds,
  });
}

const FOCUS_FOV_DEG = 25;
const focusScratch = new THREE.Vector3();
function focusCameraOnImageMeasurement(id: string): boolean {
  const handle = overlays.getImageMeasurementById(id);
  if (!handle) return false;
  handle.getWorldPosition(focusScratch);
  const { az, alt } = vecToAzAlt(focusScratch.x, focusScratch.y, focusScratch.z);
  viewer.setAzAlt(az, alt);
  viewer.setFov(FOCUS_FOV_DEG);
  overlays.setSelectedImageMeasurement(handle);
  return true;
}

async function bootstrap(): Promise<void> {
  // Map measurements are global (no station ownership). Load them up-front
  // so both the station map and the index map can render them without an
  // additional fetch later.
  const mmReady = loadMapMeasurements();

  if (currentStationId) {
    await hydrateFromAPI(currentStationId);
    await mmReady;
    const prefs = loadPrefs(currentStationId);
    settings.apply(prefs);
    if (prefs.tab !== undefined) viewTabs.setMode(prefs.tab);
    overlays.setSelected(null);
    overlays.setSelectedImageMeasurement(null);
    overlays.setSelectedMapMeasurement(null);
    admin.setVisible(true);
    if (focusImageMeasurementId) {
      // Run after prefs.apply so the focus override wins, and force the 360°
      // tab since the focus is a viewer-space bearing.
      if (focusCameraOnImageMeasurement(focusImageMeasurementId)) {
        viewTabs.setMode('360');
      } else {
        console.warn('focus image measurement not found:', focusImageMeasurementId);
      }
    }
  } else {
    void showStationMarkers();
    const cpsReady = showIndexControlPoints();
    if (focusIndexControlPointId) {
      // Wait for the CP layer to populate before panning, or the lookup misses.
      // applyLocationGate (below) flips to the map tab so the CPs actually draw.
      void cpsReady.then(() => {
        if (!mapView.focusIndexControlPoint(focusIndexControlPointId)) {
          console.warn('focus control point not found:', focusIndexControlPointId);
        }
      });
    }
  }
  sync.markLoaded();
  applyLocationGate();
  hud.refresh();
  refreshSelectionUI();
  viewer.start();
}

void bootstrap();
