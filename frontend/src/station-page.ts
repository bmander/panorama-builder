// Station route: the 360° photo viewer for a single station, with all the
// scene composition and editor wiring that goes with it. Composes the smaller
// station-fields, solve-actions, and station-navigation modules.

import * as THREE from 'three';
import * as api from './api.js';
import type { ApiHydratedStation } from './api.js';
import { dirFromAzAlt } from './overlay.js';
import { attachInput } from './input.js';
import type { PhotoBodyHit } from './input.js';
import { attachDownload } from './ui.js';
import { findHitColumn } from './map-poi-columns.js';
import { createCPConstraintModal } from './cp-constraint-modal.js';
import { createCPSurfaceModal } from './cp-surface-modal.js';
import { createSundialModal } from './sundial-modal.js';
import type { SundialPickField } from './sundial-modal.js';
import { findHitDot } from './dot-layer.js';
import type { Dot } from './dot-layer.js';
import {
  cpHref, cpLabel, formatLifespanLines, getElement,
  poiData,
} from './types.js';
import { latLngToCameraRelativeMeters, tangentMetersToLatLng } from './geo.js';
import { vertexToLatLngAlt } from './camera-anchored.js';
import { radToDeg } from './mathx.js';
import { createSessionPanel } from './session-panel.js';
import { createSettingsPanel } from './settings.js';
import { createAdminModal } from './admin-modal.js';
import { attachHamburgerMenu } from './hamburger-menu.js';
import { createContextMenu } from './context-menu.js';
import type { ContextMenuItem } from './context-menu.js';
import { createObservationModal } from './observation-modal.js';
import { createPhotoHud } from './photo-hud.js';
import { createUndoManager } from './undo.js';
import { createStationNavigation } from './station-navigation.js';
import { createStationFields } from './station-fields.js';
import { attachSolveActions } from './solve-actions.js';
import type { SolveActions } from './solve-actions.js';
import { locEq } from './world-camera.js';
import { createStationScene } from './station/scene.js';
import { createStationRouteState } from './station/route-state.js';
import { createStationDataController } from './station/data-controller.js';

export interface MountStationPageOptions {
  initialStationId: string;
  focusImageMeasurementId: string | null;
  focusControlPointId: string | null;
}

const SHIFT_WHEEL_LOG_PER_PX = 0.005;
const COLUMN_NDC_HIT_RADIUS = 0.01;
const STATION_DOT_HIT_PX = 10;

export async function mountStationPage(opts: MountStationPageOptions): Promise<void> {
  const route = createStationRouteState(opts);
  const getCurrentStationId = (): string => route.getStationId();

  // --- Viewer + scene singletons -----------------------------------------

  const scene = createStationScene({ container: document.body });
  const {
    viewer, overlays, worldCamera,
    terrain, sky, sunMarker,
    cpColumns, cpConstraintLines, cpSurfacesRenderer, photoPreviews,
    baker, hud,
    sundialLine, previewLine, previewPositions,
  } = scene;

  // Selection state (slice 4 will own this).
  let selectedConstraintId: string | null = null;
  let multiSelectedConstraintIds: ReadonlySet<string> = new Set();
  let selectedSurfaceId: string | null = null;
  let selectedStationId: string | null = null;

  // Fan out pose changes to every camera-anchored consumer except terrain.
  // Subscribed below; fires automatically on every worldCamera mutation.
  function pushPose(): void {
    scene.applyPose({
      cpMarkers: data.getCpMarkers(),
      visibleCps: data.getVisibleCps(),
      observationRays: data.getObservationRays(),
      otherStations: data.getOtherStations(),
      otherCameras: data.getOtherCameras(),
      selectedStationId,
      cpConstraints: data.getCpConstraints(),
      selectedConstraintId,
      multiSelectedConstraintIds,
      cpSurfaces: data.getCpSurfaces(),
      selectedSurfaceId,
      sundialMarkerDots,
      sundialGnomonCpId: sundialModal.getGnomonCpId(),
      sundialShadow: sundialModal.getShadowLocation(),
    });
  }
  worldCamera.subscribe(pushPose);

  const data = createStationDataController({
    scene, route,
    getCapturedAt: () => stationFields.getCapturedAt(),
    hydrateStationFields: (s) => { stationFields.hydrate(s); },
    refreshSunDirection: () => { settings.refreshSunDirection(); },
    getSelectedStationId: () => selectedStationId,
    onRefresh: () => { pushPose(); },
  });
  const { sync, handlers } = data;

  // attachSolveActions runs much later in this function; the widget's Solve
  // button isn't reachable until then, so the late binding is safe.
  let solveActions: SolveActions | null = null;
  createSessionPanel(getElement('session-host'), {
    onSolve: () => { solveActions?.open(); },
  });

  const settings = createSettingsPanel({
    viewer, terrain, sunMarker, sky,
    getCameraLocation: () => worldCamera.getPose().stationAnchor,
    onShowAllCPsChange: value => { data.setShowAllCPs(value); },
    onCpMaxDistanceChange: meters => { data.setCpMaxDistanceM(meters); },
    onSurfaceOpacityChange: opacity => { cpSurfacesRenderer.setOpacity(opacity); },
  });

  const admin = createAdminModal({ getCurrentStationId });

  const cpConstraintModal = createCPConstraintModal({
    getControlPoints: () => overlays.controlPoints.list(),
    onMutated: () => {
      selectedConstraintId = null;
      void data.reloadCPConstraints();
    },
    onClose: () => {
      if (selectedConstraintId !== null) {
        selectedConstraintId = null;
        data.refreshControlPointColumns();
      }
    },
  });

  const cpSurfaceModal = createCPSurfaceModal({
    onMutated: () => {
      selectedSurfaceId = null;
      void data.reloadCPSurfaces();
    },
    onClose: () => {
      if (selectedSurfaceId !== null) {
        selectedSurfaceId = null;
        data.refreshControlPointColumns();
      }
    },
  });

  // Sundial visuals (dot layer + line) live in scene; this is the per-pick
  // dot list that feeds them, plus the shadow-point color.
  const SUNDIAL_SHADOW_COLOR = new THREE.Color(0xffaa44);
  let sundialMarkerDots: readonly Dot[] = [];

  // Sundial picker state: while non-null, the next CP marker click (or
  // surface click) is routed to the modal instead of opening its default
  // context menu / delete modal.
  let activePicker: SundialPickField | null = null;
  const sundialModal = createSundialModal({
    getControlPoint: (id) => overlays.controlPoints.getById(id),
    getCapturedAtYear: () => {
      const at = stationFields.getCapturedAt();
      if (!at) return null;
      const y = new Date(at).getUTCFullYear();
      return Number.isFinite(y) ? y : null;
    },
    onPickStart: (field) => { activePicker = field; },
    onPicksChange: () => {
      const loc = sundialModal.getShadowLocation();
      sundialMarkerDots = loc === null
        ? []
        : [{ anchor: loc.latlng, altitude: loc.altitude, color: SUNDIAL_SHADOW_COLOR }];
      pushPose();
    },
  });
  getElement<HTMLButtonElement>('sun-dial-btn').addEventListener('click', () => {
    sundialModal.open();
  });

  attachHamburgerMenu();

  // Coarse-pointer viewports start collapsed to reclaim vertical space.
  {
    const panel = getElement('params-panel');
    const toggle = getElement<HTMLButtonElement>('params-toggle');
    function setCollapsed(collapsed: boolean): void {
      panel.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.textContent = collapsed ? '▸' : '▾';
    }
    setCollapsed(matchMedia('(pointer: coarse)').matches);
    toggle.addEventListener('click', () => {
      setCollapsed(!panel.classList.contains('collapsed'));
    });
  }

  function setMultiSelectedConstraintIds(next: ReadonlySet<string>): void {
    multiSelectedConstraintIds = next;
    const n = next.size;
    const hudEl = getElement('constraint-multiselect-hud');
    const countEl = getElement('constraint-multiselect-count');
    const btnEl = getElement<HTMLButtonElement>('constraint-add-surface-btn');
    hudEl.hidden = n === 0;
    countEl.textContent = String(n);
    btnEl.disabled = n !== 2;
    // Only the constraint-line color changes; skip the heavier marker /
    // observation refresh in refreshControlPointColumns.
    const pose = worldCamera.getPose();
    cpConstraintLines.update(pose.location, pose.altitudeMSL, data.getVisibleCps(), data.getCpConstraints(), selectedConstraintId, multiSelectedConstraintIds);
    viewer.requestRender();
  }

  function toggleMultiSelectedConstraint(constraintId: string): void {
    const next = new Set(multiSelectedConstraintIds);
    if (next.has(constraintId)) next.delete(constraintId);
    else next.add(constraintId);
    setMultiSelectedConstraintIds(next);
  }

  function clearMultiSelectedConstraints(): void {
    if (multiSelectedConstraintIds.size === 0) return;
    setMultiSelectedConstraintIds(new Set());
  }

  getElement<HTMLButtonElement>('constraint-add-surface-btn').addEventListener('click', () => {
    if (multiSelectedConstraintIds.size !== 2) return;
    const [id1, id2] = [...multiSelectedConstraintIds];
    const constraints = data.getCpConstraints();
    const c1 = constraints.find(k => k.id === id1);
    const c2 = constraints.find(k => k.id === id2);
    if (!c1 || !c2) return;
    const a1 = c1.cpAId, a2 = c1.cpBId, b1 = c2.cpAId, b2 = c2.cpBId;
    const set1 = new Set([a1, a2]);
    const sharedFromC2 = [b1, b2].filter(x => set1.has(x));
    if (sharedFromC2.length === 2) {
      alert('Constraints share both endpoints.');
      return;
    }
    let body: api.ApiCPSurfaceCreate;
    if (sharedFromC2.length === 1) {
      const s = sharedFromC2[0]!;
      const other1 = a1 === s ? a2 : a1;
      const other2 = b1 === s ? b2 : b1;
      body = { cp_1_id: s, cp_2_id: other1, cp_3_id: other2 };
    } else {
      // Cyclic order a1 → a2 → b2 → b1 puts each constraint on an opposite
      // side of the quad, so the polygon never self-intersects regardless
      // of which order the user shift-clicked.
      body = { cp_1_id: a1, cp_2_id: a2, cp_3_id: b2, cp_4_id: b1 };
    }
    void api.createCPSurface(body).then(() => {
      clearMultiSelectedConstraints();
      void data.reloadCPSurfaces();
    }).catch((err: unknown) => {
      console.error('create cp surface failed:', err);
      alert('Could not create surface — see console.');
    });
  });
  getElement<HTMLButtonElement>('constraint-multiselect-clear').addEventListener('click', clearMultiSelectedConstraints);

  // Mutations no longer trigger a solve — the solver is backend-side, behind
  // the explicit Solve buttons.
  overlays.setCallbacks({
    onMutate: () => {
      viewer.requestRender();
      baker.markDirty();
      data.refreshControlPointColumns();
      sync.flush();
    },
    onSelectionChange: () => {
      viewer.requestRender();
      data.refreshControlPointColumns();
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

  const contextMenu = createContextMenu();
  const undoManager = createUndoManager({
    overlays, sync,
    reportError: (label, err) => { sync.reportError(label, err); },
  });
  const photoHud = createPhotoHud({ overlays, sync, undoManager });
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
    const info = cp ? formatLifespanLines(cp) : undefined;
    const items: ContextMenuItem[] = [
      { label: 'View control point →', onClick: () => { location.assign(cpHref(cpId)); } },
    ];
    // Crosshairs are hidden by default and only appear for the selected CP.
    // Clicking the CP marker selects one of its measurements on this station
    // so every observation reticule for the CP becomes visible at once.
    const ownMeasurements = overlays.measurements.list()
      .filter(im => im.controlPointId === cpId);
    if (ownMeasurements.length > 0) {
      overlays.measurements.setSelected(ownMeasurements[0]!.handle);
    }
    const stationObserves = ownMeasurements.length > 0;
    if (!stationObserves && body) {
      items.push({
        label: 'Add observation here',
        onClick: () => { void handlers.onMatchImageMeasurement(body.overlay, body.u, body.v, cpId); },
      });
    }
    // Negative-visibility submenu — missing / can't see (with reason). Posts
    // a cp_observation row at this station; the merge-time recompute folds
    // it into the CP's derived window. Only offered when this station has no
    // crosshair on the CP yet — once a crosshair exists, the implicit
    // `observed` row is already in place. ("Add observation here" above
    // covers the positive case, so a separate "Mark observed" would be
    // redundant.)
    if (!stationObserves) {
      const observingStationId = getCurrentStationId();
      const postObservation = (status: api.ApiCpObservationStatus, reason?: api.ApiCpObservationReason): void => {
        const prior = data.getCpObservation(cpId);
        data.setCpObservation(cpId, { id: prior?.id ?? null, status });
        data.refreshControlPointColumns();
        const req: Promise<api.ApiCpObservation> = prior?.id
          ? api.updateCpObservation(prior.id, { status, reason: reason ?? null })
          : api.createCpObservation(observingStationId, {
              control_point_id: cpId,
              status,
              reason: reason ?? null,
            });
        req.then(o => { data.setCpObservation(cpId, { id: o.id, status: o.status }); })
          .catch((err: unknown) => {
            console.error('cp_observation upsert failed:', err);
            if (prior) data.setCpObservation(cpId, prior);
            else data.deleteCpObservation(cpId);
            data.refreshControlPointColumns();
            alert('Update failed — see console.');
          });
      };
      items.push(
        { label: 'Mark missing', onClick: () => { postObservation('missing'); } },
        { label: 'Can\'t see — occluded', onClick: () => { postObservation('cant_see', 'occluded'); } },
        { label: 'Can\'t see — unclear', onClick: () => { postObservation('cant_see', 'unclear'); } },
      );
    }
    // Nudge the menu right so the CP marker (and any reticules just
    // revealed by the selection above) stays uncovered by the menu.
    contextMenu.open(sx + 20, sy, items, header, info);
  }

  function writeCameraToURL(): void {
    const { azimuth, altitude } = viewer.getAzAlt();
    const pose = worldCamera.getPose();
    const anchored = locEq(pose.location, pose.stationAnchor)
      && pose.altitudeMSL === pose.stationAltitudeMSL;
    route.writeCameraToURL({
      azDeg: radToDeg(azimuth),
      altDeg: radToDeg(altitude),
      fovDeg: viewer.camera.fov,
      live: !anchored && pose.location
        ? { lat: pose.location.lat, lng: pose.location.lng, altitudeMSL: pose.altitudeMSL }
        : null,
    });
  }

  attachInput({
    viewer,
    overlays,
    onChange: () => {
      viewer.requestRender();
      hud.refresh();
      photoHud.refresh();
      writeCameraToURL();
    },
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
      scene.pushTerrainFromPose();
      writeCameraToURL();
    },
    findColumnAtNDC: ndc => {
      const pose = worldCamera.getPose();
      if (!pose.stationAnchor) return null;
      return findHitColumn(ndc, COLUMN_NDC_HIT_RADIUS, viewer.camera, pose.stationAnchor,
        pose.altitudeMSL, data.getVisibleCps());
    },
    onHoveredColumnChange: id => { cpColumns.setHoveredMarker(id); },
    onPhotoBodyContextMenu: (overlay, u, v, sx, sy) => {
      contextMenu.open(sx, sy, [
        { label: 'Add observation here', onClick: () => { observationModal.open(overlay, u, v); } },
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
      const others = data.getOtherStations();
      if (!pose.stationAnchor || others.length === 0) return null;
      const canvas = viewer.renderer.domElement;
      return findHitDot(ndc, STATION_DOT_HIT_PX,
        canvas.clientWidth, canvas.clientHeight, viewer.camera, pose.stationAnchor,
        pose.altitudeMSL, others);
    },
    onStationClick: (id, sx, sy) => {
      if (selectedStationId !== id) {
        selectedStationId = id;
        data.refreshControlPointColumns();
      }
      const st = data.getOtherStations().find(s => s.id === id);
      const header = st?.name ?? `Untitled ${id.slice(0, 6)}`;
      contextMenu.open(sx, sy, [
        { label: 'Go to camera →', onClick: () => { void stationNavigation.flyToStation(id); } },
      ], header);
    },
    onDeselectStation: () => {
      if (selectedStationId === null) return;
      selectedStationId = null;
      data.refreshControlPointColumns();
    },
    onCPClick: (cpId, sx, sy, body) => {
      if (activePicker === 'gnomon') {
        activePicker = null;
        sundialModal.onGnomonPicked(cpId);
        return;
      }
      openCpContextMenu(cpId, sx, sy, body);
    },
    findConstraintAtNDC: ndc => cpConstraintLines.findHit(ndc, COLUMN_NDC_HIT_RADIUS, viewer.camera),
    onConstraintClick: (constraintId, _sx, _sy, shiftKey) => {
      if (shiftKey) {
        toggleMultiSelectedConstraint(constraintId);
        return;
      }
      // Plain click clears any multi-select and opens the edit modal.
      clearMultiSelectedConstraints();
      const constraint = data.getCpConstraints().find(k => k.id === constraintId);
      if (!constraint) return;
      selectedConstraintId = constraintId;
      data.refreshControlPointColumns();
      cpConstraintModal.openEdit(constraint);
    },
    findSurfaceAtNDC: ndc => cpSurfacesRenderer.findHit(ndc, viewer.camera),
    onSurfaceClick: (surfaceId, _sx, _sy, point) => {
      if (activePicker === 'shadow') {
        activePicker = null;
        const pose = worldCamera.getPose();
        if (pose.location) {
          sundialModal.onShadowPicked(surfaceId, vertexToLatLngAlt(point, pose.location, pose.altitudeMSL));
        }
        return;
      }
      selectedSurfaceId = surfaceId;
      data.refreshControlPointColumns();
      cpSurfaceModal.open(surfaceId);
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
      scene.pushTerrainFromPose();
    },
    onLocationChanged: (loc) => {
      const pose = worldCamera.getPose();
      // Form events for a station that has no anchor yet shouldn't be
      // possible (the form is bound only after hydrate sets the anchor),
      // but be explicit rather than silently anchor at sea level.
      if (pose.stationAltitudeMSL === null) return;
      data.applyCameraLocation(loc, pose.stationAltitudeMSL);
    },
  });

  solveActions = attachSolveActions({
    rehydrate: () => data.rehydrateAfterSolve(),
    reportError: (label, err) => { sync.reportError(label, err); },
  });

  const stationNavigation = createStationNavigation({
    viewer, terrain, cpColumns, photoPreviews,
    worldCamera,
    getCurrentStationId,
    getStationName: () => stationFields.getNameAndAlt()?.name ?? null,
    getOtherStations: () => data.getOtherStations(),
    setOtherStations: (s) => { data.setOtherStations(s); },
    loadStation: (newId, prefetched) => loadStation(newId, prefetched),
  });

  // --- Hydrate + bootstrap -----------------------------------------------

  // Reset interactions + sundial bits on station swap; data.clear() handles
  // the heavy lifting (sync reset, overlay teardown, list resets, observation
  // cache, worldCamera).
  function clearStationData(): void {
    data.clear();
    selectedStationId = null;
    selectedConstraintId = null;
    clearMultiSelectedConstraints();
    selectedSurfaceId = null;
    sundialModal.reset();
    sundialMarkerDots = [];
    sundialLine.visible = false;
    previewLine.visible = false;
  }

  // Swap to `newId` in place. Caller is responsible for the URL: fly /
  // station-clicks should pushState first; popstate just calls this.
  async function applyStation(newId: string, prefetched?: ApiHydratedStation): Promise<void> {
    if (newId === route.getStationId()) return;
    route.clearFocusedCpId();
    route.setStationId(newId);
    clearStationData();
    await data.load(newId, prefetched);
  }

  async function loadStation(newId: string, prefetched?: ApiHydratedStation): Promise<void> {
    if (newId !== route.getStationId()) route.pushStationToHistory(newId);
    await applyStation(newId, prefetched);
  }

  route.onPopState(sta => {
    if (!sta) return;
    if (sta !== route.getStationId()) void applyStation(sta);
    else data.applyCameraFromURL();
  });

  viewer.setCanvasVisible(true);
  hud.setVisible(true);
  getElement('params-panel').hidden = false;
  // Start the rAF loop before hydrate so the grid sky paints immediately and
  // each terrain ring / photo texture appears as it arrives, instead of the
  // canvas staying black until every parallel fetch resolves.
  viewer.start();

  await data.load(route.getStationId(), undefined, () => {
    overlays.photos.setSelected(null);
    overlays.measurements.setSelected(null);
    admin.setVisible(true);
    // URL-supplied focus deep-link. URL camera params (applied just after
    // this hook returns) take precedence so bookmarks restore exactly.
    const focusedCpId = route.getFocusedCpId();
    const focusImageMeasurementId = route.consumeFocusImageMeasurementId();
    if (focusedCpId) {
      if (!data.focusCameraOnControlPoint(focusedCpId)) {
        console.warn('focus control point not resolvable:', focusedCpId);
      }
    } else if (focusImageMeasurementId && !data.focusCameraOnImageMeasurement(focusImageMeasurementId)) {
      console.warn('focus image measurement not found:', focusImageMeasurementId);
    }
  });

  hud.refresh();
  photoHud.refresh();
}
