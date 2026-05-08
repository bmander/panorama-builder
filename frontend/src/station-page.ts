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
import type { PhotoBodyHit } from './input.js';
import { createHud, attachDownload } from './ui.js';
import { createTerrainView } from './terrain.js';
import { createSunMarker } from './sun-marker.js';
import { createControlPointColumns, findHitColumn } from './map-poi-columns.js';
import type { ControlPointColumn } from './map-poi-columns.js';
import { createObservationRays } from './observation-rays.js';
import type { ObservationRay } from './observation-rays.js';
import { createStationMarkers } from './station-markers.js';
import type { StationMarker } from './station-markers.js';
import { createStationCones } from './station-cones.js';
import { findHitDot } from './dot-layer.js';
import {
  cpHref, cpLabel, cpLifespanFromApi, getElement, indexStationHref, isExtantAt,
  meshMat, overlayData, poiData,
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
      overlays.measurements.setFovScale(halfFovTan(fov) / POI_FOV_REFERENCE_TAN);
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
  const observationRays = createObservationRays({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  const stationCones = createStationCones({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  let otherStations: StationMarker[] = [];
  let otherCameras: OtherCamera[] = [];
  let selectedStationId: string | null = null;
  const baker = createBaker({
    renderer: viewer.renderer,
    scene: viewer.scene,
    setVisualsVisible: visible => {
      overlays.setVisualsVisible(visible);
      cpColumns.setVisible(visible);
      stationDots.setVisible(visible);
      observationRays.setVisible(visible);
      stationCones.setVisible(visible);
    },
  });
  const hud = createHud(() => {
    const { azimuth, altitude } = viewer.getAzAlt();
    const sel = overlays.photos.getSelected();
    let selectedRadPerPixel: number | null = null;
    if (sel) {
      const data = overlayData(sel);
      const img = meshMat(data.body).map?.image as
        { naturalWidth?: number; width?: number } | null | undefined;
      const px = img?.naturalWidth ?? img?.width ?? 0;
      if (px > 0) selectedRadPerPixel = data.sizeRad / px;
    }
    return {
      azimuth, altitude,
      fov: viewer.camera.fov,
      selectedSizeRad: sel ? overlayData(sel).sizeRad : null,
      selectedRadPerPixel,
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

  // Hydrated per-photo data for every other station. Populated once via a
  // batch of api.getStation calls; used to render frustum cones and to
  // build observation rays for the currently-selected camera.
  interface OtherCameraMeasurement {
    readonly id: string;
    readonly u: number;
    readonly v: number;
    readonly controlPointId: string | null;
  }
  interface OtherCamera {
    readonly stationId: string;
    readonly photoId: string;
    readonly fromLat: number;
    readonly fromLng: number;
    readonly fromAlt: number;
    readonly photoAz: number;
    readonly photoTilt: number;
    readonly photoRoll: number;
    readonly sizeRad: number;
    readonly aspect: number;
    readonly measurements: readonly OtherCameraMeasurement[];
  }

  // CPs visible in the photo viewer. Same set drives column rendering and
  // the matcher hit-test, so what you see is what you can click.
  // Lifespan filter applies in both modes: a CP that didn't exist when the
  // photographer was here shouldn't render even if some image measurement
  // happens to reference it.
  function getVisibleControlPoints(): ControlPointView[] {
    const capturedAt = stationFields.getCapturedAt();
    const capturedMs = capturedAt !== null ? new Date(capturedAt).getTime() : null;
    const all = overlays.controlPoints.list().filter(cp => {
      if (cp.estLat === null || cp.estLng === null) return false;
      if (capturedMs !== null && !isExtantAt(cp, capturedMs)) return false;
      return true;
    });
    if (showAllCPs) return all;
    const observed = new Set<string>();
    for (const im of overlays.measurements.list()) {
      if (im.controlPointId) observed.add(im.controlPointId);
    }
    return all.filter(cp => observed.has(cp.id));
  }

  // Reused empty array so the no-op guard inside observationRays.update
  // catches refreshes when nothing is selected (the common case).
  const EMPTY_RAYS: readonly ObservationRay[] = [];

  // Built fresh when there's a selection; per-CP location and selected
  // station id can both change between calls, and the ray count is small
  // (~measurements on one station's photos) so per-call allocation is
  // negligible.
  function buildObservationRays(): readonly ObservationRay[] {
    if (selectedStationId === null) return EMPTY_RAYS;
    const out: ObservationRay[] = [];
    for (const cam of otherCameras) {
      if (cam.stationId !== selectedStationId) continue;
      for (const im of cam.measurements) {
        const cp = im.controlPointId ? overlays.controlPoints.getById(im.controlPointId) : null;
        const estLat = cp?.estLat ?? null;
        const estLng = cp?.estLng ?? null;
        if (estLat === null || estLng === null) {
          out.push({
            kind: 'null',
            fromLat: cam.fromLat, fromLng: cam.fromLng, fromAlt: cam.fromAlt,
            photoAz: cam.photoAz, photoTilt: cam.photoTilt, photoRoll: cam.photoRoll,
            sizeRad: cam.sizeRad, aspect: cam.aspect,
            u: im.u, v: im.v,
          });
          continue;
        }
        out.push({
          kind: 'located',
          fromLat: cam.fromLat, fromLng: cam.fromLng, fromAlt: cam.fromAlt,
          toLat: estLat, toLng: estLng, toAlt: cp?.estAlt ?? null,
        });
      }
    }
    return out;
  }

  function refreshControlPointColumns(): void {
    const cps = getVisibleControlPoints();
    const handlesByCpId = new Map<string, THREE.Object3D[]>();
    for (const im of overlays.measurements.list()) {
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
    const cameraHeight = terrain.getCameraHeight();
    cpColumns.update(stationLocation, cameraHeight, markers);
    stationDots.update(stationLocation, cameraHeight, otherStations);
    stationCones.update(stationLocation, cameraHeight, otherCameras, selectedStationId);
    observationRays.update(stationLocation, cameraHeight, buildObservationRays());
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
    if (overlays.controlPoints.getById(cp.id) !== null) return;
    overlays.controlPoints.add(cp.id, {
      description: cp.description, estLat: cp.est_lat, estLng: cp.est_lng, estAlt: cp.est_alt,
      ...cpLifespanFromApi(cp),
    });
    sync.registerControlPoint(cp.id, {
      description: cp.description, est_lat: cp.est_lat, est_lng: cp.est_lng, est_alt: cp.est_alt,
    });
  }

  function syncControlPoint(cp: ApiControlPoint): void {
    sync.registerControlPoint(cp.id, {
      description: cp.description, est_lat: cp.est_lat, est_lng: cp.est_lng, est_alt: cp.est_alt,
    });
    if (overlays.controlPoints.getById(cp.id) === null) {
      overlays.controlPoints.add(cp.id, {
        description: cp.description, estLat: cp.est_lat, estLng: cp.est_lng, estAlt: cp.est_alt,
        ...cpLifespanFromApi(cp),
      });
      return;
    }
    overlays.withBatch(() => {
      overlays.controlPoints.setDescription(cp.id, cp.description);
      overlays.controlPoints.setEst(cp.id, {
        lat: cp.est_lat, lng: cp.est_lng, alt: cp.est_alt,
      });
      overlays.controlPoints.setLifespan(cp.id, cpLifespanFromApi(cp));
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
    const opacity = overlays.photos.getSelectedOpacity();
    if (opacity === null) {
      opacityRowEl.style.display = 'none';
      return;
    }
    opacityRowEl.style.display = '';
    opacitySliderEl.value = String(Math.round(opacity * 100));
  }

  opacitySliderEl.addEventListener('input', () => {
    overlays.photos.setSelectedOpacity(parseFloat(opacitySliderEl.value) / 100);
  });

  const contextMenu = createContextMenu();
  const undoManager = createUndoManager({
    overlays, sync,
    reportError: (label, err) => { sync.reportError(label, err); },
  });
  const photoParamsModal = createPhotoParamsModal({ overlays, sync, undoManager });
  const observationModal = createObservationModal({
    getControlPoints: () => overlays.controlPoints.list(),
    onPickExisting: (overlay, u, v, controlPointId) => {
      void handlers.onMatchImageMeasurement(overlay, u, v, controlPointId);
    },
    onCreateAndObserve: (overlay, u, v, description) =>
      handlers.onCreateCPAndObserve(overlay, u, v, description),
  });

  // "Add observation here" is suppressed when this station already observes
  // the CP (duplicates aren't useful) or when the click missed any photo
  // body (no u/v anchor to attach the observation to).
  function openCpContextMenu(
    cpId: string, sx: number, sy: number, body: PhotoBodyHit | null,
  ): void {
    const cp = overlays.controlPoints.getById(cpId);
    const header = cpLabel(cp?.description ?? '');
    const items: ContextMenuItem[] = [
      { label: 'View control point →', onClick: () => { location.assign(cpHref(cpId)); } },
    ];
    const stationObserves = overlays.measurements.list()
      .some(im => im.controlPointId === cpId);
    if (!stationObserves && body) {
      items.push({
        label: 'Add observation here',
        onClick: () => { void handlers.onMatchImageMeasurement(body.overlay, body.u, body.v, cpId); },
      });
    }
    const stationDate = stationFields.getCapturedAt();
    if (stationDate !== null) {
      const dateLabel = new Date(stationDate).toLocaleDateString();
      items.push(
        {
          label: `Started after ${dateLabel}`,
          onClick: () => {
            const current = overlays.controlPoints.getById(cpId);
            if (current) {
              overlays.controlPoints.setLifespan(cpId, {
                startedAt: stationDate, startedAfter: true,
                endedAt: current.endedAt, endedBefore: current.endedBefore,
              });
            }
            api.updateControlPoint(cpId, { started_at: stationDate, started_after: true })
              .catch((err: unknown) => {
                console.error('set started_after failed:', err);
                alert('Update failed — see console.');
              });
          },
        },
        {
          label: `Ended before ${dateLabel}`,
          onClick: () => {
            const current = overlays.controlPoints.getById(cpId);
            if (current) {
              overlays.controlPoints.setLifespan(cpId, {
                startedAt: current.startedAt, startedAfter: current.startedAfter,
                endedAt: stationDate, endedBefore: true,
              });
            }
            api.updateControlPoint(cpId, { ended_at: stationDate, ended_before: true })
              .catch((err: unknown) => {
                console.error('set ended_before failed:', err);
                alert('Update failed — see console.');
              });
          },
        },
      );
    }
    contextMenu.open(sx, sy, items, header);
  }

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
      openCpContextMenu(cpId, sx, sy, null);
    },
    findStationAtNDC: ndc => {
      if (!stationLocation || otherStations.length === 0) return null;
      return findHitDot(ndc, COLUMN_NDC_HIT_RADIUS, viewer.camera, stationLocation,
        terrain.getCameraHeight(), otherStations);
    },
    onStationClick: (id, sx, sy) => {
      if (selectedStationId !== id) {
        selectedStationId = id;
        refreshControlPointColumns();
      }
      const st = otherStations.find(s => s.id === id);
      const header = st?.name ?? `Untitled ${id.slice(0, 6)}`;
      contextMenu.open(sx, sy, [
        { label: 'Go to camera →', onClick: () => { void stationNavigation.flyToStation(id); } },
      ], header);
    },
    onDeselectStation: () => {
      if (selectedStationId === null) return;
      selectedStationId = null;
      refreshControlPointColumns();
    },
    onCPClick: (cpId, sx, sy, body) => { openCpContextMenu(cpId, sx, sy, body); },
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
        const o = overlays.photos.getById(p.id);
        if (!o) continue;
        overlays.photos.applyPose(o, {
          photoAz: p.photo_az, photoTilt: p.photo_tilt, photoRoll: p.photo_roll,
          sizeRad: p.size_rad, aspect: p.aspect, camLat: data.station.lat, camLng: data.station.lng,
          k1: p.dist_k1, k2: p.dist_k2,
        });
        overlays.photos.setLocks(o, {
          lockPhotoAz: p.lock_photo_az, lockPhotoTilt: p.lock_photo_tilt,
          lockPhotoRoll: p.lock_photo_roll, lockSizeRad: p.lock_size_rad,
          lockDistK1: p.lock_dist_k1, lockDistK2: p.lock_dist_k2,
        });
        sync.registerPhoto(p.id, {
          aspect: p.aspect, photo_az: p.photo_az, photo_tilt: p.photo_tilt,
          photo_roll: p.photo_roll, size_rad: p.size_rad, opacity: p.opacity,
          dist_k1: p.dist_k1, dist_k2: p.dist_k2,
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
        const o = overlays.photos.addPending(p.aspect, dir, { id: p.id });
        overlays.photos.applyPose(o, {
          photoAz: p.photo_az, photoTilt: p.photo_tilt, photoRoll: p.photo_roll,
          sizeRad: p.size_rad, aspect: p.aspect, camLat: loc.lat, camLng: loc.lng,
          k1: p.dist_k1, k2: p.dist_k2,
        });
        overlays.photos.setOpacity(o, p.opacity);
        overlays.photos.setLocks(o, {
          lockPhotoAz: p.lock_photo_az, lockPhotoTilt: p.lock_photo_tilt,
          lockPhotoRoll: p.lock_photo_roll, lockSizeRad: p.lock_size_rad,
          lockDistK1: p.lock_dist_k1, lockDistK2: p.lock_dist_k2,
        });
        sync.registerPhoto(p.id, {
          aspect: p.aspect, photo_az: p.photo_az, photo_tilt: p.photo_tilt,
          photo_roll: p.photo_roll, size_rad: p.size_rad, opacity: p.opacity,
          dist_k1: p.dist_k1, dist_k2: p.dist_k2,
        });
        loader.load(
          api.photoBlobUrl(p.id),
          tex => { overlays.photos.setTexture(o, tex); },
          undefined,
          err => { console.error(`photo ${p.id} load failed:`, err); },
        );
      }

      // Control points first so subsequent measurement adds reference an existing CP entry.
      for (const cp of data.control_points) {
        registerControlPoint(cp);
      }

      for (const im of data.image_measurements) {
        const overlay = overlays.photos.getById(im.photo_id);
        if (!overlay) continue;
        overlays.measurements.add(overlay, im.u, im.v, {
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
      // Non-blocking: dots already render without the per-photo data.
      void Promise.all(otherStations.map(s => api.getStation(s.id)))
        .then(hydrated => {
          const cams: OtherCamera[] = [];
          for (const d of hydrated) {
            const measByPhotoId = new Map<string, OtherCameraMeasurement[]>();
            for (const im of d.image_measurements) {
              const arr = measByPhotoId.get(im.photo_id) ?? [];
              arr.push({ id: im.id, u: im.u, v: im.v, controlPointId: im.control_point_id });
              measByPhotoId.set(im.photo_id, arr);
            }
            for (const p of d.photos) {
              cams.push({
                stationId: d.station.id,
                photoId: p.id,
                fromLat: d.station.lat, fromLng: d.station.lng, fromAlt: d.station.alt,
                photoAz: p.photo_az, photoTilt: p.photo_tilt, photoRoll: p.photo_roll,
                sizeRad: p.size_rad, aspect: p.aspect,
                measurements: measByPhotoId.get(p.id) ?? [],
              });
            }
          }
          otherCameras = cams;
          refreshControlPointColumns();
        })
        .catch((err: unknown) => { console.error('fetch other-station photos failed:', err); });
    } else {
      console.error('list stations failed:', stationsRes.reason);
    }
  }

  const focusScratch = new THREE.Vector3();
  function focusCameraOnImageMeasurement(id: string): boolean {
    const handle = overlays.measurements.getById(id);
    if (!handle) return false;
    handle.getWorldPosition(focusScratch);
    const { az, alt } = vecToAzAlt(focusScratch.x, focusScratch.y, focusScratch.z);
    viewer.setAzAlt(az, alt);
    viewer.setFov(FOCUS_FOV_DEG);
    overlays.measurements.setSelected(handle);
    return true;
  }

  viewer.setCanvasVisible(true);
  hud.setVisible(true);

  await hydrateFromAPI(stationId);
  overlays.photos.setSelected(null);
  overlays.measurements.setSelected(null);
  admin.setVisible(true);
  if (focusImageMeasurementId && !focusCameraOnImageMeasurement(focusImageMeasurementId)) {
    console.warn('focus image measurement not found:', focusImageMeasurementId);
  }

  sync.markLoaded();
  hud.refresh();
  refreshSelectionUI();
  viewer.start();
}
