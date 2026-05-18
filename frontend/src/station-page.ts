// Station route: the 360° photo viewer for a single station, with all the
// scene composition and editor wiring that goes with it. Composes the smaller
// station-fields, solve-actions, and station-navigation modules.

import * as THREE from 'three';
import type { ApiHydratedStation } from './api.js';
import { attachDownload } from './ui.js';
import { createCPConstraintModal } from './cp-constraint-modal.js';
import { createCPSurfaceModal } from './cp-surface-modal.js';
import { createSundialModal } from './sundial-modal.js';
import type { SundialPickField } from './sundial-modal.js';
import type { Dot } from './dot-layer.js';
import { getElement } from './types.js';
import { createSessionPanel } from './session-panel.js';
import { createSettingsPanel } from './settings.js';
import { createAdminModal } from './admin-modal.js';
import { attachHamburgerMenu } from './hamburger-menu.js';
import { createContextMenu } from './context-menu.js';
import { createObservationModal } from './observation-modal.js';
import { createPhotoHud } from './photo-hud.js';
import { createUndoManager } from './undo.js';
import { createStationNavigation } from './station-navigation.js';
import { createStationFields } from './station-fields.js';
import { attachSolveActions } from './solve-actions.js';
import type { SolveActions } from './solve-actions.js';
import { createStationScene } from './station/scene.js';
import { createStationRouteState } from './station/route-state.js';
import { createStationDataController } from './station/data-controller.js';
import { createStationInteractions } from './station/interactions.js';

export interface MountStationPageOptions {
  initialStationId: string;
  focusImageMeasurementId: string | null;
  focusControlPointId: string | null;
}

export async function mountStationPage(opts: MountStationPageOptions): Promise<void> {
  const route = createStationRouteState(opts);
  const getCurrentStationId = (): string => route.getStationId();

  // --- Viewer + scene singletons -----------------------------------------

  const scene = createStationScene({ container: document.body });
  const {
    viewer, overlays, worldCamera,
    terrain, sky, sunMarker,
    cpSurfacesRenderer,
    baker, hud,
    sundialLine, previewLine,
  } = scene;

  // Fan out pose changes to every camera-anchored consumer except terrain.
  // Subscribed below; fires automatically on every worldCamera mutation.
  function pushPose(): void {
    scene.applyPose({
      cpMarkers: data.getCpMarkers(),
      visibleCps: data.getVisibleCps(),
      observationRays: data.getObservationRays(),
      otherStations: data.getOtherStations(),
      otherCameras: data.getOtherCameras(),
      selectedStationId: interactions.getSelectedStationId(),
      cpConstraints: data.getCpConstraints(),
      selectedConstraintId: interactions.getSelectedConstraintId(),
      multiSelectedConstraintIds: interactions.getMultiSelectedConstraintIds(),
      cpSurfaces: data.getCpSurfaces(),
      selectedSurfaceId: interactions.getSelectedSurfaceId(),
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
    getSelectedStationId: () => interactions.getSelectedStationId(),
    onRefresh: () => { pushPose(); },
  });
  const { sync } = data;

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
      interactions.clearConstraintSelection();
      void data.reloadCPConstraints();
    },
    onClose: () => { interactions.clearConstraintSelection(); },
  });

  const cpSurfaceModal = createCPSurfaceModal({
    onMutated: () => {
      interactions.clearSurfaceSelection();
      void data.reloadCPSurfaces();
    },
    onClose: () => { interactions.clearSurfaceSelection(); },
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

  const contextMenu = createContextMenu();
  const undoManager = createUndoManager({
    overlays, sync,
    reportError: (label, err) => { sync.reportError(label, err); },
  });
  const photoHud = createPhotoHud({ overlays, sync, undoManager });
  const observationModal = createObservationModal({
    getControlPoints: () => overlays.controlPoints.list(),
    onPickExisting: (overlay, u, v, controlPointId) => {
      void data.handlers.onMatchImageMeasurement(overlay, u, v, controlPointId);
    },
    onCreateAndObserve: (overlay, u, v, description) =>
      data.handlers.onCreateCPAndObserve(overlay, u, v, description),
  });

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
    viewer, terrain,
    cpColumns: scene.cpColumns,
    photoPreviews: scene.photoPreviews,
    worldCamera,
    getCurrentStationId,
    getStationName: () => stationFields.getNameAndAlt()?.name ?? null,
    getOtherStations: () => data.getOtherStations(),
    setOtherStations: (s) => { data.setOtherStations(s); },
    loadStation: (newId, prefetched) => loadStation(newId, prefetched),
  });

  const interactions = createStationInteractions({
    scene, data, route,
    contextMenu, observationModal, sundialModal,
    photoHud, undoManager, stationNavigation,
    openConstraintCreate: (a, b) => { cpConstraintModal.openCreate(a, b); },
    openConstraintEdit: (c) => { cpConstraintModal.openEdit(c); },
    openSurfaceEdit: (id) => { cpSurfaceModal.open(id); },
    getActivePicker: () => activePicker,
    setActivePicker: (p) => { activePicker = p; },
  });

  attachDownload({ baker });

  // --- Hydrate + bootstrap -----------------------------------------------

  // Reset interactions + sundial bits on station swap; data.clear() handles
  // the heavy lifting (sync reset, overlay teardown, list resets, observation
  // cache, worldCamera).
  function clearStationData(): void {
    data.clear();
    interactions.clearAll();
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
