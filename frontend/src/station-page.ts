// Station route: the 360° photo viewer for a single station, with all the
// scene composition and editor wiring that goes with it. Composes the smaller
// station-fields, solve-actions, and station-navigation modules.

import * as THREE from 'three';
import * as api from './api.js';
import type { ApiControlPoint, ApiHydratedStation } from './api.js';
import { createViewer, DEFAULT_FOV } from './viewer.js';
import { createOverlayManager, dirFromAzAlt } from './overlay.js';
import { createBaker } from './bake.js';
import { attachInput } from './input.js';
import { createHud, attachDownload } from './ui.js';
import { createTerrainView } from './terrain.js';
import { createSunMarker } from './sun-marker.js';
import { createControlPointColumns, findHitColumn } from './map-poi-columns.js';
import type { ControlPointColumn } from './map-poi-columns.js';
import { createStationMarkers } from './station-markers.js';
import type { StationMarker } from './station-markers.js';
import { findHitDot } from './dot-layer.js';
import {
  cpHref, cpLabel, getElement, indexStationHref,
  overlayData, poiData,
} from './types.js';
import { vecToAzAlt } from './geo.js';
import { degToRad } from './mathx.js';
import type { ControlPointView, LatLng } from './types.js';
import { createSyncManager } from './sync.js';
import { createSettingsPanel } from './settings.js';
import { createOrchestration } from './handlers.js';
import { createAdminModal } from './admin-modal.js';
import { createContextMenu } from './context-menu.js';
import type { ContextMenuItem } from './context-menu.js';
import { createObservationModal } from './observation-modal.js';
import { createPhotoParamsModal } from './photo-params-modal.js';
import { createUndoManager } from './undo.js';
import { createStationNavigation, meanPhotoAzAlt } from './station-navigation.js';
import { createStationFields } from './station-fields.js';
import { attachSolveActions } from './solve-actions.js';

export interface MountStationPageOptions {
  stationId: string;
  focusImageMeasurementId: string | null;
}

const SHIFT_WHEEL_LOG_PER_PX = 0.005;
const COLUMN_NDC_HIT_RADIUS = 0.01;
const FOCUS_FOV_DEG = 25;

export async function mountStationPage(opts: MountStationPageOptions): Promise<void> {
  const { stationId, focusImageMeasurementId } = opts;
  const getCurrentStationId = (): string | null => stationId;

  getElement<HTMLAnchorElement>('view-on-map').href = indexStationHref(stationId);

  // --- Viewer + scene singletons -----------------------------------------

  const halfFovTan = (fovDeg: number): number => Math.tan(degToRad(fovDeg) / 2);
  const POI_FOV_REFERENCE_TAN = halfFovTan(DEFAULT_FOV);
  const viewer = createViewer({
    container: document.body,
    onFovChange: fov => {
      // Skip the per-overlay rescale during a fly: photos are hidden, and
      // setFov fires every tween frame.
      if (!viewer.overlaysGroup.visible) return;
      overlays.setPoiFovScale(halfFovTan(fov) / POI_FOV_REFERENCE_TAN);
    },
  });

  // Callbacks are attached below via setCallbacks once sync, baker, and the
  // refreshers exist — see the construction-order note in overlay.ts.
  const overlays = createOverlayManager({
    overlaysGroup: viewer.overlaysGroup,
    getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
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
  const stationDots = createStationMarkers({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  let otherStations: StationMarker[] = [];
  const baker = createBaker({
    renderer: viewer.renderer,
    scene: viewer.scene,
    setVisualsVisible: visible => {
      overlays.setVisualsVisible(visible);
      cpColumns.setVisible(visible);
      stationDots.setVisible(visible);
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

  // When true, the photo viewer renders every located CP as a marker, not
  // just those observed by this station. Toggled from the settings panel.
  let showAllCPs = false;

  // CPs visible in the photo viewer. Same set drives column rendering and
  // the matcher hit-test, so what you see is what you can click.
  function getVisibleControlPoints(): ControlPointView[] {
    const all = overlays.getControlPoints().filter(cp =>
      cp.estLat !== null && cp.estLng !== null,
    );
    if (showAllCPs) return all;
    const observed = new Set<string>();
    for (const im of overlays.getImageMeasurements()) {
      if (im.controlPointId) observed.add(im.controlPointId);
    }
    return all.filter(cp => observed.has(cp.id));
  }

  function refreshControlPointColumns(): void {
    const cps = getVisibleControlPoints();
    const handlesByCpId = new Map<string, THREE.Object3D[]>();
    for (const im of overlays.getImageMeasurements()) {
      if (!im.controlPointId) continue;
      const arr = handlesByCpId.get(im.controlPointId);
      if (arr) arr.push(im.handle);
      else handlesByCpId.set(im.controlPointId, [im.handle]);
    }
    const markers: ControlPointColumn[] = cps.map(cp => ({
      id: cp.id,
      anchor: { lat: cp.estLat!, lng: cp.estLng! },
      altitude: cp.estAlt,
      selected: cp.selected,
      observations: handlesByCpId.get(cp.id) ?? [],
    }));
    cpColumns.update(stationLocation, terrain.getCameraHeight(), markers);
    stationDots.update(stationLocation, terrain.getCameraHeight(), otherStations);
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
    });
  }

  function syncControlPoint(cp: ApiControlPoint): void {
    sync.registerControlPoint(cp.id, {
      description: cp.description, est_lat: cp.est_lat, est_lng: cp.est_lng, est_alt: cp.est_alt,
    });
    if (overlays.getControlPointById(cp.id) === null) {
      overlays.addControlPoint(cp.id, {
        description: cp.description, estLat: cp.est_lat, estLng: cp.est_lng, estAlt: cp.est_alt,
      });
      return;
    }
    overlays.withBatch(() => {
      overlays.setControlPointDescription(cp.id, cp.description);
      overlays.setControlPointEst(cp.id, {
        lat: cp.est_lat, lng: cp.est_lng, alt: cp.est_alt,
      });
    });
  }

  // --- Sync, settings, handlers, admin -----------------------------------

  const sync = createSyncManager({ overlays, getCurrentStationId });

  const settings = createSettingsPanel({
    viewer, terrain, sunMarker,
    getCameraLocation: getStationLocation,
    onShowAllCPsChange: value => {
      showAllCPs = value;
      refreshControlPointColumns();
    },
  });

  const handlers = createOrchestration({
    getCurrentStationId,
    overlays,
    sync,
  });

  const admin = createAdminModal({ getCurrentStationId });

  // Mutations no longer trigger a solve — the solver is backend-side, behind
  // the explicit Solve buttons.
  overlays.setCallbacks({
    onMutate: () => {
      viewer.requestRender();
      baker.markDirty();
      refreshControlPointColumns();
      sync.flush();
    },
    onSelectionChange: () => {
      viewer.requestRender();
      refreshControlPointColumns();
    },
    onLightMutate: () => {
      viewer.requestRender();
      baker.markDirty();
      sync.flush();
    },
  });

  // --- Input wiring + modals ---------------------------------------------

  // Modal-style file picker for menu actions ("Replace image…"). Resolves
  // with the chosen File or null on cancel.
  function pickImageFile(): Promise<File | null> {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      let settled = false;
      const finish = (file: File | null): void => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(file);
      };
      input.addEventListener('change', () => { finish(input.files?.[0] ?? null); });
      input.addEventListener('cancel', () => { finish(null); });
      document.body.appendChild(input);
      input.click();
    });
  }

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
  const undoManager = createUndoManager({
    overlays, sync,
    reportError: (label, err) => { sync.reportError(label, err); },
  });
  const photoParamsModal = createPhotoParamsModal({ overlays, sync, undoManager });
  const observationModal = createObservationModal({
    getControlPoints: () => overlays.getControlPoints(),
    onPickExisting: (overlay, u, v, controlPointId) => {
      void handlers.onMatchImageMeasurement(overlay, u, v, controlPointId);
    },
    onCreateAndObserve: (overlay, u, v, description) =>
      handlers.onCreateCPAndObserve(overlay, u, v, description),
  });

  attachInput({
    viewer,
    overlays,
    onChange: () => { viewer.requestRender(); hud.refresh(); refreshSelectionUI(); },
    onPhotoDropped: (tex, blob, aspect, dir, revokeUrl) => {
      void handlers.onPhotoDropped(tex, blob, aspect, dir, revokeUrl);
    },
    onShiftWheel: deltaPx => {
      const h = terrain.getCameraHeight();
      const s = Math.sign(h) * Math.log1p(Math.abs(h)) - deltaPx * SHIFT_WHEEL_LOG_PER_PX;
      const next = Math.sign(s) * Math.expm1(Math.abs(s));
      if (!terrain.setCameraHeight(next)) return;
      hud.refresh();
      refreshControlPointColumns(); // markers' world-y depends on cameraHeight
    },
    findColumnAtNDC: ndc => {
      if (!stationLocation) return null;
      return findHitColumn(ndc, COLUMN_NDC_HIT_RADIUS, viewer.camera, stationLocation,
        terrain.getCameraHeight(), getVisibleControlPoints());
    },
    onHoveredColumnChange: id => { cpColumns.setHoveredMarker(id); },
    onPhotoBodyContextMenu: (overlay, u, v, sx, sy) => {
      contextMenu.open(sx, sy, [
        { label: 'Add observation here', onClick: () => { observationModal.open(overlay, u, v); } },
        { label: 'Photo parameters…', onClick: () => { photoParamsModal.open(overlay); } },
        { label: 'Replace image…', onClick: () => {
          void pickImageFile().then(file => {
            if (file) void handlers.onReplacePhoto(overlay, file);
          });
        } },
      ]);
    },
    onImagePOIContextMenu: (poi, sx, sy) => {
      const cpId = poiData(poi).controlPointId;
      if (!cpId) return;
      contextMenu.open(sx, sy, [
        { label: 'View control point →', onClick: () => { location.assign(cpHref(cpId)); } },
      ]);
    },
    findStationAtNDC: ndc => {
      if (!stationLocation || otherStations.length === 0) return null;
      return findHitDot(ndc, COLUMN_NDC_HIT_RADIUS, viewer.camera, stationLocation,
        terrain.getCameraHeight(), otherStations);
    },
    onStationClick: (id, sx, sy) => {
      const st = otherStations.find(s => s.id === id);
      const header = st?.name ?? `Untitled ${id.slice(0, 6)}`;
      contextMenu.open(sx, sy, [
        { label: 'Go to camera →', onClick: () => { void stationNavigation.flyToStation(id); } },
      ], header);
    },
    onCPClick: (cpId, sx, sy, body) => {
      const cp = overlays.getControlPointById(cpId);
      const header = cpLabel(cp?.description ?? '');
      const items: ContextMenuItem[] = [
        { label: 'View control point →', onClick: () => { location.assign(cpHref(cpId)); } },
      ];
      // Skip the "add observation" option when this station already observes
      // the CP — duplicates aren't useful — or when the click missed any
      // photo body (no u/v anchor to attach the observation to).
      const stationObserves = overlays.getImageMeasurements()
        .some(im => im.controlPointId === cpId);
      if (!stationObserves && body) {
        items.push({
          label: 'Add observation here',
          onClick: () => { void handlers.onMatchImageMeasurement(body.overlay, body.u, body.v, cpId); },
        });
      }
      contextMenu.open(sx, sy, items, header);
    },
    undoManager,
  });

  attachDownload({ baker });

  // --- Station fields, solve, navigation ---------------------------------

  const stationFields = createStationFields({
    stationId,
    onAltitudeChanged: (alt) => {
      // Keep the viewer's vertical reference in sync with the station's recorded
      // altitude — otherwise CP columns (rendered at est_alt − cameraHeight) drift
      // visually from the photo POIs (which the solver projects against the real
      // station altitude). Shift+wheel still nudges cameraHeight locally; the next
      // station-alt update re-syncs.
      if (terrain.setCameraHeight(alt)) refreshControlPointColumns();
    },
    onLocationChanged: (loc) => { applyCameraLocation(loc); },
  });

  async function rehydrateAfterSolve(): Promise<void> {
    const data = await api.getStation(stationId);
    stationFields.hydrate(data.station);
    overlays.withBatch(() => {
      const loc: LatLng = { lat: data.station.lat, lng: data.station.lng };
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

  attachSolveActions({
    stationId,
    rehydrate: rehydrateAfterSolve,
    reportError: (label, err) => { sync.reportError(label, err); },
  });

  const stationNavigation = createStationNavigation({
    viewer, terrain, cpColumns, stationDots,
    currentStationId: stationId,
    getStationLocation: () => stationLocation,
    setStationLocation: (loc) => { stationLocation = loc; },
    getStationCache: stationFields.getNameAndAlt,
    getOtherStations: () => otherStations,
    setOtherStations: (s) => { otherStations = [...s]; },
  });

  // --- Hydrate + bootstrap -----------------------------------------------

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
    applyCameraLocation(loc);
    stationFields.hydrate(data.station);

    // Center the viewport on the mean of the station's photo directions.
    // Matches the orientation the fly-between animation lands at, so a fly
    // followed by the post-fly reload doesn't snap-rotate. A URL-supplied
    // ?focus=<im> deep-link overrides this below.
    const meanOrient = meanPhotoAzAlt(data.photos);
    if (meanOrient) viewer.setAzAlt(meanOrient.az, meanOrient.alt);

    // Place each photo synchronously with a placeholder so the viewer can
    // paint terrain + rectangles before any blob arrives.
    const loader = new THREE.TextureLoader();
    overlays.withBatch(() => {
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

      for (const im of data.image_measurements) {
        const overlay = overlays.getOverlayById(im.photo_id);
        if (!overlay) continue;
        overlays.addImageMeasurement(overlay, im.u, im.v, {
          id: im.id,
          controlPointId: im.control_point_id,
        });
        sync.registerImageMeasurement(im.id, { u: im.u, v: im.v, control_point_id: im.control_point_id });
      }
    });

    // Independent fetches — kick off in parallel so hydrate latency isn't
    // gated on the slower of the two.
    const [cpsRes, stationsRes] = await Promise.allSettled([
      api.listControlPoints(),
      api.listStations(),
    ]);
    overlays.withBatch(() => {
      if (cpsRes.status === 'fulfilled') {
        for (const cp of cpsRes.value) registerControlPoint(cp);
      } else {
        console.error('list control points failed:', cpsRes.reason);
      }
    });
    if (stationsRes.status === 'fulfilled') {
      // Skip the current station: a dot at (0,0,0) just sits on top of the camera.
      otherStations = stationsRes.value
        .filter(st => st.id !== id)
        .map(st => ({ id: st.id, name: st.name, anchor: { lat: st.lat, lng: st.lng }, altitude: st.alt }));
      refreshControlPointColumns();
    } else {
      console.error('list stations failed:', stationsRes.reason);
    }
  }

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

  viewer.setCanvasVisible(true);
  hud.setVisible(true);

  await hydrateFromAPI(stationId);
  overlays.setSelected(null);
  overlays.setSelectedImageMeasurement(null);
  admin.setVisible(true);
  if (focusImageMeasurementId && !focusCameraOnImageMeasurement(focusImageMeasurementId)) {
    console.warn('focus image measurement not found:', focusImageMeasurementId);
  }

  sync.markLoaded();
  hud.refresh();
  refreshSelectionUI();
  viewer.start();
}
