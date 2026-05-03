import * as THREE from 'three';
import { createViewer } from './viewer.js';
import { createOverlayManager, dirFromAzAlt } from './overlay.js';
import { createBaker } from './bake.js';
import { attachInput } from './input.js';
import { createHud, attachDownload } from './ui.js';
import { createMapView } from './map.js';
import type { MapView } from './map.js';
import { createTerrainView } from './terrain.js';
import { createSunMarker } from './sun-marker.js';
import { createControlPointColumns, findHitColumn } from './map-poi-columns.js';
import type { ControlPointColumn } from './map-poi-columns.js';
import { cpHref, FOCUS_QUERY_PARAM, getElement, INDEX_CP_QUERY_PARAM, INDEX_STATION_QUERY_PARAM, indexStationHref, overlayData, poiData, stationHref } from './types.js';
import { vecToAzAlt } from './geo.js';
import type { ControlPointView, LatLng } from './types.js';
import * as api from './api.js';
import type { ApiControlPoint, ApiHydratedStation, ApiStation } from './api.js';
import { loadPrefs } from './prefs.js';
import { createSyncManager } from './sync.js';
import { createSettingsPanel } from './settings.js';
import { createOrchestration } from './handlers.js';
import { createAdminModal } from './admin-modal.js';
import { createStartStationModal } from './start-station-modal.js';
import { createContextMenu } from './context-menu.js';
import { createObservationModal } from './observation-modal.js';
import { createPhotoParamsModal } from './photo-params-modal.js';

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
const focusIndexStationId: string | null = (() => {
  const id = new URLSearchParams(location.search).get(INDEX_STATION_QUERY_PARAM);
  return id && FOCUS_RE.test(id) ? id : null;
})();

// Index mode (no station in URL) hides the station-scoped chrome — the
// upper-right buttons only make sense once a station is loaded.
if (currentStationId === null) {
  getElement('top-right').hidden = true;
} else {
  getElement<HTMLAnchorElement>('view-on-map').href = indexStationHref(currentStationId);
}

// --- Viewer + scene singletons -----------------------------------------

const viewer = createViewer({ container: document.body });

const overlays = createOverlayManager({
  overlaysGroup: viewer.overlaysGroup,
  getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
  // The closure captures sync, settings — both declared below.
  // Safe because onMutate fires only after bootstrap, by which point every
  // const is bound. Solving is no longer triggered by mutations: the solver
  // lives on the backend and runs only when the user clicks Solve.
  onMutate: () => {
    viewer.requestRender();
    if (currentStationId) {
      baker.markDirty();
      refreshControlPointColumns();
    }
    sync.flush();
    settings.persist();
  },
  onSelectionChange: () => {
    viewer.requestRender();
    if (currentStationId) refreshControlPointColumns();
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

// Camera location for the station page. Not user-editable post-creation:
// there's no map UI on the station view to drag the pin.
let stationLocation: LatLng | null = null;
const getStationLocation = (): LatLng | null => stationLocation;

// --- Cross-cutting refreshers ------------------------------------------

// CPs with an estimated location that are observed by at least one image
// measurement on this station. Same set drives column rendering and the
// matcher hit-test, so what you see is what you can click.
function getStationObservedControlPoints(): ControlPointView[] {
  const observed = new Set<string>();
  for (const im of overlays.getImageMeasurements()) {
    if (im.controlPointId) observed.add(im.controlPointId);
  }
  return overlays.getControlPoints().filter(cp =>
    cp.estLat !== null && cp.estLng !== null && observed.has(cp.id),
  );
}

function refreshControlPointColumns(): void {
  const cps = getStationObservedControlPoints();
  const ims = overlays.getImageMeasurements();
  const markers: ControlPointColumn[] = cps.map(cp => ({
    id: cp.id,
    anchor: { lat: cp.estLat!, lng: cp.estLng! },
    altitude: cp.estAlt,
    selected: cp.selected,
    observations: ims
      .filter(im => im.controlPointId === cp.id)
      .map(im => im.handle),
  }));
  cpColumns.update(stationLocation, terrain.getCameraHeight(), markers);
}

function applyCameraLocation(loc: LatLng): void {
  stationLocation = loc;
  terrain.setLocation(loc);
  settings.refreshSunDirection();
  refreshControlPointColumns();
  // Mark the location dirty so the next flush PUTs it.
  sync.flush();
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

// --- Sync, settings, handlers, admin -----------------------------------

const sync = createSyncManager({
  overlays,
  getCurrentStationId,
  getCameraLocation: getStationLocation,
});

const settings = createSettingsPanel({
  viewer, terrain, sunMarker,
  getCameraLocation: getStationLocation,
  getCurrentStationId,
});

const handlers = createOrchestration({
  getCurrentStationId,
  overlays,
  sync,
});

const admin = createAdminModal({ getCurrentStationId });
const startStationModal = createStartStationModal({
  onSubmit: input => handlers.onStartStationHere(input),
});

// --- Map (index page only) + input wiring ------------------------------

let mapView: MapView | null = null;

const SHIFT_WHEEL_LOG_PER_PX = 0.005;
const COLUMN_NDC_HIT_RADIUS = 0.01;

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
const photoParamsModal = createPhotoParamsModal({ overlays, sync });
const observationModal = createObservationModal({
  getControlPoints: () => overlays.getControlPoints(),
  onPickExisting: (overlay, u, v, controlPointId) => {
    void handlers.onMatchImageMeasurement(overlay, u, v, controlPointId);
  },
  onCreateAndObserve: (overlay, u, v, description) =>
    handlers.onCreateCPAndObserve(overlay, u, v, description),
  onCreateMapAndObserve: async (latlng, description, estAlt) => {
    await handlers.onCreateCPAtLocation(latlng, description, estAlt);
    refreshIndexControlPoints();
  },
});

attachInput({
  viewer,
  overlays,
  onChange: () => { viewer.requestRender(); hud.refresh(); refreshSelectionUI(); settings.persist(); },
  onPhotoDropped: (tex, blob, aspect, dir, revokeUrl) => {
    void handlers.onPhotoDropped(tex, blob, aspect, dir, revokeUrl);
  },
  onMatchImagePOI: (overlay, u, v, controlPointId) => {
    void handlers.onMatchImageMeasurement(overlay, u, v, controlPointId);
  },
  onShiftWheel: deltaPx => {
    const h = terrain.getCameraHeight();
    const s = Math.sign(h) * Math.log1p(Math.abs(h)) - deltaPx * SHIFT_WHEEL_LOG_PER_PX;
    const next = Math.sign(s) * Math.expm1(Math.abs(s));
    if (!terrain.setCameraHeight(next)) return;
    hud.refresh();
    refreshControlPointColumns(); // markers' world-y depends on cameraHeight
    settings.persist();
  },
  findColumnAtNDC: ndc => {
    if (!stationLocation) return null;
    return findHitColumn(ndc, COLUMN_NDC_HIT_RADIUS, viewer.camera, stationLocation,
      terrain.getCameraHeight(), getStationObservedControlPoints());
  },
  onHoveredColumnChange: id => { cpColumns.setHoveredMarker(id); },
  onPhotoBodyContextMenu: (overlay, u, v, sx, sy) => {
    contextMenu.open(sx, sy, [
      { label: 'Add observation here', onClick: () => { observationModal.open(overlay, u, v); } },
      { label: 'Photo parameters…', onClick: () => { photoParamsModal.open(overlay); } },
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

attachDownload({ baker });

// --- Solve buttons -----------------------------------------------------

// After a successful solve we re-fetch the hydrated station and replay it
// over the scene-graph. The /solve handler returns the diff in result.changes,
// but the simplest correct way to mirror it is to re-hydrate; the cost is one
// extra GET per solve, which is fine for a button-driven flow.
async function applySolveResultByRefetch(label: string, run: () => Promise<api.SolveResult>): Promise<void> {
  let result: api.SolveResult;
  try {
    result = await run();
  } catch (err) {
    sync.reportError(label, err);
    return;
  }
  if (result.diverged) {
    alert(`${label}: solver made no progress.`);
    return;
  }
  if (currentStationId) {
    try {
      await rehydrateAfterSolve(currentStationId);
    } catch (err) {
      sync.reportError('reload after solve', err);
    }
  }
  refreshIndexControlPoints();
}

async function rehydrateAfterSolve(id: string): Promise<void> {
  const data = await api.getStation(id);
  overlays.withBatch(() => {
    const loc: LatLng = { lat: data.station.lat, lng: data.station.lng };
    sync.registerLocation(loc);
    applyCameraLocation(loc);
    for (const p of data.photos) {
      const o = overlays.getOverlayById(p.id);
      if (!o) continue;
      overlays.applyPose(o, {
        photoAz: p.photo_az, photoTilt: p.photo_tilt, photoRoll: p.photo_roll,
        sizeRad: p.size_rad, aspect: p.aspect, camLat: data.station.lat, camLng: data.station.lng,
      });
      overlays.setPhotoLocks(o, {
        lockPhotoAz: p.lock_photo_az, lockPhotoTilt: p.lock_photo_tilt,
        lockPhotoRoll: p.lock_photo_roll, lockSizeRad: p.lock_size_rad,
      });
      sync.registerPhoto(p.id, {
        aspect: p.aspect, photo_az: p.photo_az, photo_tilt: p.photo_tilt,
        photo_roll: p.photo_roll, size_rad: p.size_rad, opacity: p.opacity,
      });
    }
    for (const cp of data.control_points) {
      syncControlPoint(cp);
    }
  });
}

const solveStationBtn = getElement<HTMLButtonElement>('solve-station-btn');
const solveJointBtn = getElement<HTMLButtonElement>('solve-joint-btn');
solveStationBtn.addEventListener('click', () => {
  if (!currentStationId) return;
  solveStationBtn.disabled = true;
  void applySolveResultByRefetch('solve station', () => api.solveStation(currentStationId))
    .finally(() => { solveStationBtn.disabled = false; });
});
solveJointBtn.addEventListener('click', () => {
  solveJointBtn.disabled = true;
  // Joint mode has hundreds of params and est_alt converges slowly. The
  // default cap (30) is too tight here; 200 gets meter-scale alt moves on
  // typical scenes without taking more than a couple seconds.
  void applySolveResultByRefetch('joint solve', () => api.solveJoint({ max_iters: 200 }))
    .finally(() => { solveJointBtn.disabled = false; });
});

// --- Station lock toggle ----------------------------------------------
//
// Joint mode requires ≥2 stations with both lat AND lng locked. We treat
// "lock this station's position" as an atomic toggle on both lat and lng
// (locking only one wouldn't fix gauge anyway).

const lockStationPosEl = getElement<HTMLInputElement>('lock-station-pos');
let stationLockState = false;
function applyStationLockUI(locked: boolean): void {
  stationLockState = locked;
  lockStationPosEl.checked = locked;
}
lockStationPosEl.addEventListener('change', () => {
  if (!currentStationId || !stationLocation) return;
  const next = lockStationPosEl.checked;
  lockStationPosEl.disabled = true;
  api.updateStation(currentStationId, stationLocation, null, next, next).then(
    updated => {
      applyStationLockUI(updated.lock_lat && updated.lock_lng);
      lockStationPosEl.disabled = false;
    },
    (err: unknown) => {
      console.error('lock station position failed:', err);
      lockStationPosEl.checked = stationLockState; // revert
      lockStationPosEl.disabled = false;
    },
  );
});

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
  applyCameraLocation(loc);
  applyStationLockUI(data.station.lock_lat && data.station.lock_lng);

  // Place each photo synchronously with a placeholder so the viewer can
  // paint terrain + rectangles before any blob arrives.
  const loader = new THREE.TextureLoader();
  for (const p of data.photos) {
    const dir = dirFromAzAlt(p.photo_az, p.photo_tilt);
    const o = overlays.addPendingOverlay(p.aspect, dir, { id: p.id });
    overlays.applyPose(o, {
      photoAz: p.photo_az, photoTilt: p.photo_tilt, photoRoll: p.photo_roll,
      sizeRad: p.size_rad, aspect: p.aspect, camLat: loc.lat, camLng: loc.lng,
    });
    overlays.setOpacity(o, p.opacity);
    overlays.setPhotoLocks(o, {
      lockPhotoAz: p.lock_photo_az, lockPhotoTilt: p.lock_photo_tilt,
      lockPhotoRoll: p.lock_photo_roll, lockSizeRad: p.lock_size_rad,
    });
    sync.registerPhoto(p.id, {
      aspect: p.aspect, photo_az: p.photo_az, photo_tilt: p.photo_tilt,
      photo_roll: p.photo_roll, size_rad: p.size_rad, opacity: p.opacity,
    });
    loader.load(
      api.photoBlobUrl(p.id),
      tex => { overlays.setOverlayTexture(o, tex); },
      undefined,
      err => { console.error(`photo ${p.id} load failed:`, err); },
    );
  }

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

async function showStationMarkers(view: MapView): Promise<void> {
  let stations: ApiStation[];
  try {
    stations = await api.listStations();
  } catch (err) {
    console.error('list stations failed:', err);
    return;
  }
  view.setStationMarkers(stations.map(st => ({
    id: st.id,
    latlng: { lat: st.lat, lng: st.lng },
    label: st.name ?? `Untitled ${st.id.slice(0, 6)}`,
  })));
}

function refreshIndexControlPoints(): void {
  if (!mapView) return;
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
  try {
    await api.solveControlPoint(id);
  } catch (err) {
    sync.reportError('solve control point location', err);
    return;
  }
  // Re-fetch the CP and update local state. Backend writes the new est_*
  // fields atomically; reading back is the simplest way to mirror them.
  let updated: ApiControlPoint;
  try {
    updated = await api.getControlPoint(id);
  } catch (err) {
    sync.reportError('reload control point after solve', err);
    return;
  }
  syncControlPoint(updated);
  refreshIndexControlPoints();
}

async function showStationPreview(id: string, view: MapView): Promise<void> {
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
  view.setStationPreview({
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
  const isStation = currentStationId !== null;
  viewer.setCanvasVisible(isStation);
  hud.setVisible(isStation);

  if (currentStationId) {
    await hydrateFromAPI(currentStationId);
    settings.apply(loadPrefs(currentStationId));
    overlays.setSelected(null);
    overlays.setSelectedImageMeasurement(null);
    admin.setVisible(true);
    if (focusImageMeasurementId && !focusCameraOnImageMeasurement(focusImageMeasurementId)) {
      console.warn('focus image measurement not found:', focusImageMeasurementId);
    }
  } else {
    // Show the map container and instantiate Leaflet (the container must be
    // visible before L.map measures it, or tiles won't load at the right size).
    getElement('map-wrap').classList.add('show');
    const view = createMapView({
      container: getElement('map'),
      onStationMarkerOpen: id => { location.assign(stationHref(id)); },
      onStationMarkerPreview: id => { void showStationPreview(id, view); },
      onStartStationHere: loc => { startStationModal.open(loc); },
      onAddControlPointHere: loc => { observationModal.openForMap(loc); },
      onControlPointSolveLocation: id => { void solveAndPersistControlPointLocation(id); },
    });
    mapView = view;
    const stationsReady = showStationMarkers(view);
    const cpsReady = showIndexControlPoints();
    if (focusIndexControlPointId) {
      // Wait for the CP layer to populate before panning, or the lookup misses.
      void cpsReady.then(() => {
        if (!view.focusIndexControlPoint(focusIndexControlPointId)) {
          console.warn('focus control point not found:', focusIndexControlPointId);
        }
      });
    }
    if (focusIndexStationId) {
      void stationsReady.then(() => {
        if (!view.focusStationMarker(focusIndexStationId)) {
          console.warn('focus station not found:', focusIndexStationId);
        }
      });
    }
  }
  sync.markLoaded();
  hud.refresh();
  refreshSelectionUI();
  viewer.start();
}

void bootstrap();
