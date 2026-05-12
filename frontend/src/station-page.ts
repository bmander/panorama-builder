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
import { createTerrainView } from './terrain/index.js';
import { createSunMarker } from './sun-marker.js';
import { createControlPointColumns, findHitColumn } from './map-poi-columns.js';
import type { ControlPointColumn } from './map-poi-columns.js';
import { createObservationRays } from './observation-rays.js';
import type { ObservationRay } from './observation-rays.js';
import { createCPConstraintLines } from './cp-constraint-lines.js';
import { createCPConstraintModal } from './cp-constraint-modal.js';
import { makeOverlayLine, makeOverlayLineMaterial } from './overlay-lines.js';
import { createStationMarkers } from './station-markers.js';
import type { StationMarker } from './station-markers.js';
import { createStationCones } from './station-cones.js';
import { createPhotoPreviews } from './photo-previews.js';
import { findHitDot } from './dot-layer.js';
import {
  cpHref, cpLabel, cpLifespanFromApi, getElement, indexStationHref, isExtantAt,
  parseStaFromURL, stationHref,
  meshMat, overlayData, poiData,
} from './types.js';
import { latLngToCameraRelativeMeters, tangentMetersToLatLng, vecToAzAlt } from './geo.js';
import { degToRad } from './mathx.js';
import type { CPConstraintView, ControlPointView, LatLng } from './types.js';
import { createSyncManager } from './sync.js';
import { createSessionPanel } from './session-panel.js';
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
import { createWorldCamera } from './world-camera.js';

export interface MountStationPageOptions {
  initialStationId: string;
  focusImageMeasurementId: string | null;
  focusControlPointId: string | null;
}

const SHIFT_WHEEL_LOG_PER_PX = 0.005;
const COLUMN_NDC_HIT_RADIUS = 0.01;
const STATION_DOT_HIT_PX = 10;
const FOCUS_FOV_DEG = 25;

export async function mountStationPage(opts: MountStationPageOptions): Promise<void> {
  const { initialStationId, focusImageMeasurementId } = opts;
  // Mutable so the URL-driven CP focus relaxes the lifespan / show-all-CPs
  // filter only while we're still on the station that owns this deep-link.
  // Cleared whenever applyStation swaps to a different station id.
  let focusedCpId = opts.focusControlPointId;
  // Mutable so loadStation(newId) can swap which station this mount is
  // bound to without recreating viewer / listeners / modals.
  let stationId = initialStationId;
  const getCurrentStationId = (): string => stationId;

  function syncViewOnMapHref(): void {
    getElement<HTMLAnchorElement>('view-on-map').href = indexStationHref(stationId);
  }
  syncViewOnMapHref();

  // --- Viewer + scene singletons -----------------------------------------

  const halfFovTan = (fovDeg: number): number => Math.tan(degToRad(fovDeg) / 2);
  const POI_FOV_REFERENCE_TAN = halfFovTan(DEFAULT_FOV);
  const viewer = createViewer({
    container: document.body,
    onFovChange: fov => {
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
  const photoPreviews = createPhotoPreviews({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
    getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
  });
  const cpConstraintLines = createCPConstraintLines({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  // Loaded once at hydrate; mutated by the modal's onMutated callback.
  let cpConstraints: CPConstraintView[] = [];
  let selectedConstraintId: string | null = null;
  // Preview line drawn during shift-click-drag. Updated in place rather than
  // pushed through the constraint-lines layer so the per-pointermove update
  // doesn't stomp the persisted lines.
  const previewMat = makeOverlayLineMaterial(0xffffff);
  const previewLine = makeOverlayLine([0, 0, 0, 0, 0, 0], previewMat);
  previewLine.visible = false;
  viewer.scene.add(previewLine);
  const previewPositions = previewLine.geometry.getAttribute('position') as THREE.BufferAttribute;
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
      cpConstraintLines.setVisible(visible);
      photoPreviews.setBakeHidden(!visible);
      if (!visible) previewLine.visible = false;
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
      cameraMSL: worldCamera.getPose().altitudeMSL,
      cameraHeightAboveGround: terrain.getCameraHeightAboveGround(),
    };
  });

  // Single source of truth for camera location + MSL. Live (override) values
  // diverge from the station anchor while shift-wheel or fly is active.
  const worldCamera = createWorldCamera();

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
  // Lifespan filter applies to non-observed CPs only: a CP that the
  // photographer actually marked here is direct evidence it existed at the
  // captured moment, and overrides any stale lifespan bound (e.g. a
  // "started after THIS-date" hint set from a sibling station with the
  // same captured_at).
  function getVisibleControlPoints(): ControlPointView[] {
    const capturedAt = stationFields.getCapturedAt();
    const capturedMs = capturedAt !== null ? new Date(capturedAt).getTime() : null;
    const observed = new Set<string>();
    for (const im of overlays.measurements.list()) {
      if (im.controlPointId) observed.add(im.controlPointId);
    }
    return overlays.controlPoints.list().filter(cp => {
      if (cp.estLat === null || cp.estLng === null) return false;
      // A focus_cp deep-link forces the CP to show through both gates.
      const forced = cp.id === focusedCpId;
      const isObserved = forced || observed.has(cp.id);
      if (!showAllCPs && !isObserved) return false;
      if (capturedMs !== null && !isObserved && !isExtantAt(cp, capturedMs)) return false;
      return true;
    });
  }

  // Reused empty array so the no-op guard inside observationRays.update
  // catches refreshes when nothing is selected (the common case).
  const EMPTY_RAYS: readonly ObservationRay[] = [];
  // Cached so onFlyFrame's per-frame call into observationRays.update
  // sees a stable array reference and skips its rebuild path. Recomputed
  // by refreshControlPointColumns whenever the underlying data changes.
  let cachedObservationRays: readonly ObservationRay[] = EMPTY_RAYS;

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

  // Cached so repushOverlayCameraAnchors hits the layers' applyTransform
  // fast path on a camera-only update instead of recomputing markers.
  let cachedCpMarkers: readonly ControlPointColumn[] = [];
  let cachedVisibleCps: readonly ControlPointView[] = [];

  function refreshControlPointColumns(): void {
    const cps = getVisibleControlPoints();
    const handlesByCpId = new Map<string, THREE.Object3D[]>();
    for (const im of overlays.measurements.list()) {
      if (!im.controlPointId) continue;
      const arr = handlesByCpId.get(im.controlPointId);
      if (arr) arr.push(im.handle);
      else handlesByCpId.set(im.controlPointId, [im.handle]);
    }
    cachedCpMarkers = cps.map(cp => ({
      id: cp.id,
      anchor: { lat: cp.estLat!, lng: cp.estLng! },
      altitude: cp.estAlt,
      selected: cp.selected,
      observations: handlesByCpId.get(cp.id) ?? [],
    }));
    cachedVisibleCps = cps;
    cachedObservationRays = buildObservationRays();
    pushPose();
  }

  // Fan out pose changes to every camera-anchored consumer except terrain.
  // Subscribed below; fires automatically on every worldCamera mutation.
  // Terrain is pushed separately so hydrateFromAPI can defer the DEM/imagery
  // tile flood to the end of its parallel-fetch block.
  function pushPose(): void {
    const pose = worldCamera.getPose();
    cpColumns.update(pose.location, pose.altitudeMSL, cachedCpMarkers);
    stationDots.update(pose.location, pose.altitudeMSL, otherStations);
    stationCones.update(pose.location, pose.altitudeMSL, otherCameras, selectedStationId);
    observationRays.update(pose.location, pose.altitudeMSL, cachedObservationRays);
    cpConstraintLines.update(pose.location, pose.altitudeMSL, cachedVisibleCps, cpConstraints, selectedConstraintId);
    updateOverlaysGroupOffset();
    hud.refresh();
  }
  worldCamera.subscribe(pushPose);

  function pushTerrainFromPose(): void {
    const pose = worldCamera.getPose();
    if (pose.location) terrain.setLocation(pose.location);
    terrain.setCameraMSL(pose.altitudeMSL);
  }

  // Photo overlays are rendered as a sphere around the camera at scene
  // origin, so by default they follow the camera. While the camera is
  // detached from the station (shift-wheel has displaced it), translate
  // overlaysGroup so the photos stay at the station's true location and
  // the user can fly past or around them.
  function updateOverlaysGroupOffset(): void {
    const pose = worldCamera.getPose();
    if (!pose.stationAnchor || !pose.location || pose.stationAltitudeMSL === null
        || (pose.location.lat === pose.stationAnchor.lat && pose.location.lng === pose.stationAnchor.lng)) {
      viewer.overlaysGroup.position.set(0, 0, 0);
      return;
    }
    const offset = latLngToCameraRelativeMeters(pose.stationAnchor, pose.location);
    viewer.overlaysGroup.position.set(offset.x, pose.stationAltitudeMSL - pose.altitudeMSL, offset.z);
  }

  function applyCameraLocation(loc: LatLng, alt: number): void {
    worldCamera.setStationAnchor({ location: loc, altitudeMSL: alt });
    pushTerrainFromPose();
    settings.refreshSunDirection();
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

  createSessionPanel(getElement('session-host'));

  const settings = createSettingsPanel({
    viewer, terrain, sunMarker,
    getCameraLocation: () => worldCamera.getPose().stationAnchor,
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

  function mapApiCPConstraint(r: api.ApiCPConstraint): CPConstraintView {
    return { id: r.id, cpAId: r.cp_a_id, cpBId: r.cp_b_id, type: r.constraint_type };
  }
  // Pulls every CP-CP constraint and rebuilds the in-scene lines. CPs are
  // global so we don't filter by station; the constraint-lines factory drops
  // any constraint whose endpoints aren't in `cps`.
  async function reloadCPConstraints(): Promise<void> {
    try {
      cpConstraints = (await api.listCPConstraints()).map(mapApiCPConstraint);
    } catch (err) {
      console.error('list cp constraints failed:', err);
      cpConstraints = [];
    }
    refreshControlPointColumns();
  }
  const cpConstraintModal = createCPConstraintModal({
    getControlPoints: () => overlays.controlPoints.list(),
    onMutated: () => {
      selectedConstraintId = null;
      void reloadCPConstraints();
    },
    onClose: () => {
      if (selectedConstraintId !== null) {
        selectedConstraintId = null;
        refreshControlPointColumns();
      }
    },
  });

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
      // Translate the camera forward (along its look direction) by a step
      // that scales with the current altitude — far above a landscape, big
      // strides; near the ground, fine. Wheel-up (deltaPx < 0) → forward.
      const pose = worldCamera.getPose();
      if (!pose.location) return;
      const { azimuth, altitude } = viewer.getAzAlt();
      // Step scale grows with the camera's height above ground, not its raw
      // MSL — far inland stations would otherwise get enormous strides simply
      // because their ground sits at high MSL.
      const stepScale = Math.max(Math.abs(terrain.getCameraHeightAboveGround()), 1);
      const step = -deltaPx * SHIFT_WHEEL_LOG_PER_PX * stepScale;
      const look = dirFromAzAlt(azimuth, altitude);
      worldCamera.setLiveCamera({
        location: tangentMetersToLatLng(pose.location, step * look.x, step * look.z),
        altitudeMSL: pose.altitudeMSL + step * look.y,
      });
      pushTerrainFromPose();
    },
    findColumnAtNDC: ndc => {
      const pose = worldCamera.getPose();
      if (!pose.stationAnchor) return null;
      return findHitColumn(ndc, COLUMN_NDC_HIT_RADIUS, viewer.camera, pose.stationAnchor,
        pose.altitudeMSL, getVisibleControlPoints());
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
      const pose = worldCamera.getPose();
      if (!pose.stationAnchor || otherStations.length === 0) return null;
      const canvas = viewer.renderer.domElement;
      return findHitDot(ndc, STATION_DOT_HIT_PX,
        canvas.clientWidth, canvas.clientHeight, viewer.camera, pose.stationAnchor,
        pose.altitudeMSL, otherStations);
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
    findConstraintAtNDC: ndc => cpConstraintLines.findHit(ndc, COLUMN_NDC_HIT_RADIUS, viewer.camera),
    onConstraintClick: (constraintId) => {
      const constraint = cpConstraints.find(k => k.id === constraintId);
      if (!constraint) return;
      selectedConstraintId = constraintId;
      refreshControlPointColumns();
      cpConstraintModal.openEdit(constraint);
    },
    onCreateCPConstraint: (cpAId, cpBId) => { cpConstraintModal.openCreate(cpAId, cpBId); },
    onCPConstraintDrawPreview: (cpAId, cpBId) => {
      const hide = (): void => {
        if (previewLine.visible) {
          previewLine.visible = false;
          viewer.requestRender();
        }
      };
      // Without both endpoints (or a camera fix) there's no meaningful 3D
      // line to draw — bail. The line reappears as soon as the cursor
      // re-enters another CP marker.
      const pose = worldCamera.getPose();
      if (!cpAId || !cpBId || !pose.stationAnchor) { hide(); return; }
      const cps = overlays.controlPoints.list();
      const a = cps.find(c => c.id === cpAId);
      const b = cps.find(c => c.id === cpBId);
      if (!a || !b) { hide(); return; }
      if (a.estLat === null || a.estLng === null || a.estAlt === null) { hide(); return; }
      if (b.estLat === null || b.estLng === null || b.estAlt === null) { hide(); return; }
      const cameraMSL = pose.altitudeMSL;
      const axz = latLngToCameraRelativeMeters({ lat: a.estLat, lng: a.estLng }, pose.stationAnchor);
      const bxz = latLngToCameraRelativeMeters({ lat: b.estLat, lng: b.estLng }, pose.stationAnchor);
      const arr = previewPositions.array as Float32Array;
      arr[0] = axz.x; arr[1] = a.estAlt - cameraMSL; arr[2] = axz.z;
      arr[3] = bxz.x; arr[4] = b.estAlt - cameraMSL; arr[5] = bxz.z;
      previewPositions.needsUpdate = true;
      previewLine.visible = true;
      viewer.requestRender();
    },
    undoManager,
  });

  attachDownload({ baker });

  // --- Station fields, solve, navigation ---------------------------------

  const stationFields = createStationFields({
    getCurrentStationId,
    onAltitudeChanged: (alt) => {
      // Re-anchor the station altitude. setStationAnchor also resets the
      // live camera to the anchor — if shift-wheel had drifted location or
      // altitude, the form edit snaps the camera back to the station.
      const pose = worldCamera.getPose();
      if (!pose.stationAnchor) return;
      worldCamera.setStationAnchor({ location: pose.stationAnchor, altitudeMSL: alt });
      pushTerrainFromPose();
    },
    onLocationChanged: (loc) => {
      const pose = worldCamera.getPose();
      // Form events for a station that has no anchor yet shouldn't be
      // possible (the form is bound only after hydrate sets the anchor),
      // but be explicit rather than silently anchor at sea level.
      if (pose.stationAltitudeMSL === null) return;
      applyCameraLocation(loc, pose.stationAltitudeMSL);
    },
  });

  async function rehydrateAfterSolve(): Promise<void> {
    const data = await api.getStation(stationId);
    stationFields.hydrate(data.station);
    overlays.withBatch(() => {
      const loc: LatLng = { lat: data.station.lat, lng: data.station.lng };
      applyCameraLocation(loc, data.station.alt);
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
    getCurrentStationId,
    rehydrate: rehydrateAfterSolve,
    reportError: (label, err) => { sync.reportError(label, err); },
  });

  const stationNavigation = createStationNavigation({
    viewer, terrain, cpColumns, photoPreviews,
    worldCamera,
    getCurrentStationId,
    getStationName: () => stationFields.getNameAndAlt()?.name ?? null,
    getOtherStations: () => otherStations,
    setOtherStations: (s) => { otherStations = [...s]; },
    loadStation,
  });

  // --- Hydrate + bootstrap -----------------------------------------------

  // Reset all per-station state so the next hydrateFromAPI starts fresh.
  function clearStationData(): void {
    // Reset sync FIRST. The overlay teardown below removes every photo /
    // measurement / CP, each of which queues a notify; the batch's
    // onMutate then runs sync.flush, and a still-loaded sync would diff
    // the empty overlay state against its baseline and DELETE the
    // backend rows for the station we're leaving. Resetting sync flips
    // `loaded` to false so flush short-circuits before issuing any
    // network call.
    sync.reset();
    overlays.withBatch(() => {
      // deleteSelected disposes textures, removes from overlaysGroup, and
      // strips child measurements via disposePoisOn. Snapshot first since
      // the loop mutates overlaysGroup.children.
      for (const o of [...overlays.photos.list()]) {
        if (!(o instanceof THREE.Group)) continue;
        overlays.photos.setSelected(o);
        overlays.photos.deleteSelected();
      }
      for (const cp of [...overlays.controlPoints.list()]) {
        overlays.controlPoints.remove(cp.id);
      }
    });
    otherStations = [];
    otherCameras = [];
    selectedStationId = null;
    cpConstraints = [];
    selectedConstraintId = null;
    worldCamera.clear();
    previewLine.visible = false;
  }

  // Swap to `newId` in place. Caller is responsible for the URL: fly /
  // station-clicks should pushState first; popstate just calls this.
  async function applyStation(newId: string, prefetched?: ApiHydratedStation): Promise<void> {
    if (newId === stationId) return;
    focusedCpId = null;
    stationId = newId;
    syncViewOnMapHref();
    clearStationData();
    await hydrateFromAPI(newId, prefetched);
    if (newId !== stationId) return;  // another loadStation took over
    sync.markLoaded();
  }

  async function loadStation(newId: string, prefetched?: ApiHydratedStation): Promise<void> {
    if (newId !== stationId) history.pushState(null, '', stationHref(newId));
    await applyStation(newId, prefetched);
  }

  addEventListener('popstate', () => {
    const sta = parseStaFromURL();
    if (sta) void applyStation(sta);
  });

  async function hydrateFromAPI(id: string, prefetched?: ApiHydratedStation): Promise<void> {
    let data: ApiHydratedStation;
    if (prefetched) {
      data = prefetched;
    } else {
      try {
        data = await api.getStation(id);
      } catch (err) {
        console.error('hydrate failed:', err);
        alert('Could not load this station.');
        return;
      }
      if (id !== stationId) return;  // user navigated away during fetch
    }
    const loc: LatLng = { lat: data.station.lat, lng: data.station.lng };
    // Anchor pose up front so subsequent reads see current values. Terrain
    // setLocation is deferred to the end of hydrate so DEM/imagery tile
    // fetches queue behind photos + markers.
    worldCamera.setStationAnchor({ location: loc, altitudeMSL: data.station.alt });
    settings.refreshSunDirection();
    sync.flush();
    stationFields.hydrate(data.station);

    // Center the viewport on the mean of the station's photo directions.
    // Matches the orientation the fly-between animation lands at, so a fly
    // followed by the post-fly reload doesn't snap-rotate. A URL-supplied
    // ?focus=<im> deep-link overrides this below.
    const meanOrient = meanPhotoAzAlt(data.photos);
    if (meanOrient) viewer.setAzAlt(meanOrient.az, meanOrient.alt);

    // Place each photo synchronously with a placeholder; blob fetches
    // ride on the network ahead of terrain tiles (see end of hydrate).
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
    // gated on the slower of the two. Constraints are global; piggy-back here
    // so they're available the moment the world view paints.
    const [cpsRes, stationsRes, consRes] = await Promise.allSettled([
      api.listControlPoints(),
      api.listStations(),
      api.listCPConstraints(),
    ]);
    if (id !== stationId) return;  // user navigated away during fetch
    overlays.withBatch(() => {
      if (cpsRes.status === 'fulfilled') {
        for (const cp of cpsRes.value) registerControlPoint(cp);
      } else {
        console.error('list control points failed:', cpsRes.reason);
      }
    });
    if (consRes.status === 'fulfilled') {
      cpConstraints = consRes.value.map(mapApiCPConstraint);
    } else {
      console.error('list cp constraints failed:', consRes.reason);
      cpConstraints = [];
    }
    if (stationsRes.status === 'fulfilled') {
      // Skip the current station: a dot at (0,0,0) just sits on top of the camera.
      otherStations = stationsRes.value
        .filter(st => st.id !== id)
        .map(st => ({ id: st.id, name: st.name, anchor: { lat: st.lat, lng: st.lng }, altitude: st.alt }));
      refreshControlPointColumns();
      // Non-blocking: dots already render without the per-photo data.
      void Promise.all(otherStations.map(s => api.getStation(s.id)))
        .then(hydrated => {
          if (id !== stationId) return;  // user navigated away
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

    // Terrain last so its tile flood queues behind every other fetch above.
    pushTerrainFromPose();
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

  function focusCameraOnControlPoint(id: string): boolean {
    const cp = overlays.controlPoints.getById(id);
    if (cp?.estLat == null || cp.estLng == null || cp.estAlt == null) return false;
    const pose = worldCamera.getPose();
    if (!pose.location) return false;
    const { x, z } = latLngToCameraRelativeMeters({ lat: cp.estLat, lng: cp.estLng }, pose.location);
    const y = cp.estAlt - pose.altitudeMSL;
    const { az, alt } = vecToAzAlt(x, y, z);
    viewer.setAzAlt(az, alt);
    viewer.setFov(FOCUS_FOV_DEG);
    return true;
  }

  viewer.setCanvasVisible(true);
  hud.setVisible(true);
  // Start the rAF loop before hydrate so the grid sky paints immediately and
  // each terrain ring / photo texture appears as it arrives, instead of the
  // canvas staying black until every parallel fetch resolves.
  viewer.start();

  await hydrateFromAPI(stationId);
  overlays.photos.setSelected(null);
  overlays.measurements.setSelected(null);
  admin.setVisible(true);
  if (focusedCpId) {
    if (!focusCameraOnControlPoint(focusedCpId)) {
      console.warn('focus control point not resolvable:', focusedCpId);
    }
  } else if (focusImageMeasurementId && !focusCameraOnImageMeasurement(focusImageMeasurementId)) {
    console.warn('focus image measurement not found:', focusImageMeasurementId);
  }

  sync.markLoaded();
  hud.refresh();
  refreshSelectionUI();
}
