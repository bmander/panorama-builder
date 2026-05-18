// Composition root for the /world?sta=<id> route. Wires the route / scene /
// sundial / data / panels / interactions controllers and the cross-cutting
// event subscriptions, then kicks off the first hydrate.

import type { ApiHydratedStation } from './api.js';
import { getElement } from './types.js';
import { createStationScene } from './station/scene.js';
import { createStationRouteState } from './station/route-state.js';
import { createStationDataController } from './station/data-controller.js';
import { createStationInteractions } from './station/interactions.js';
import { createSundialController } from './station/sundial-controller.js';
import { createStationPanels } from './station/panels.js';
import { wireStationEvents } from './station/wiring.js';

export interface MountStationPageOptions {
  initialStationId: string;
  focusImageMeasurementId: string | null;
  focusControlPointId: string | null;
}

export async function mountStationPage(opts: MountStationPageOptions): Promise<void> {
  const route = createStationRouteState(opts);
  const scene = createStationScene({ container: document.body });

  const sundial = createSundialController({
    getControlPoint: (id) => scene.overlays.controlPoints.getById(id),
    getCapturedAtYear: () => {
      const at = panels.stationFields.getCapturedAt();
      if (!at) return null;
      const y = new Date(at).getUTCFullYear();
      return Number.isFinite(y) ? y : null;
    },
  });

  const data = createStationDataController({
    scene, route,
    getCapturedAt: () => panels.stationFields.getCapturedAt(),
    hydrateStationFields: (s) => { panels.stationFields.hydrate(s); },
    refreshSunDirection: () => { panels.settings.refreshSunDirection(); },
    getSelectedStationId: () => interactions.getSelectedStationId(),
    onRefresh: () => { pushPose(); },
  });

  const panels = createStationPanels({
    scene, data, route, sundial,
    onCpConstraintMutated: () => { interactions.clearConstraintSelection(); },
    onCpConstraintClose: () => { interactions.clearConstraintSelection(); },
    onCpSurfaceMutated: () => { interactions.clearSurfaceSelection(); },
    onCpSurfaceClose: () => { interactions.clearSurfaceSelection(); },
    loadStation,
  });

  const interactions = createStationInteractions({
    scene, data, route, sundial,
    contextMenu: panels.contextMenu,
    observationModal: panels.observationModal,
    photoHud: panels.photoHud,
    undoManager: panels.undoManager,
    stationNavigation: panels.stationNavigation,
    openConstraintCreate: (a, b) => { panels.cpConstraintModal.openCreate(a, b); },
    openConstraintEdit: (c) => { panels.cpConstraintModal.openEdit(c); },
    openSurfaceEdit: (id) => { panels.cpSurfaceModal.open(id); },
  });

  wireStationEvents({ scene, data, route, sundial, pushPose, applyStation });

  scene.viewer.setCanvasVisible(true);
  scene.hud.setVisible(true);
  getElement('params-panel').hidden = false;
  // Start the rAF loop before hydrate so the grid sky paints immediately and
  // each terrain ring / photo texture appears as it arrives, instead of the
  // canvas staying black until every parallel fetch resolves.
  scene.viewer.start();

  await data.load(route.getStationId(), undefined, () => {
    scene.overlays.photos.setSelected(null);
    scene.overlays.measurements.setSelected(null);
    panels.admin.setVisible(true);
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

  scene.hud.refresh();
  panels.photoHud.refresh();

  // Hoisted helpers — referenced from the controller construction above. They
  // close over the outer consts (scene, data, route, sundial, interactions,
  // panels); JS hoists the function declarations so the references resolve,
  // and the closures only fire after every const has been initialized.

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
      sundialMarkerDots: sundial.getMarkerDots(),
      sundialGnomonCpId: sundial.getGnomonCpId(),
      sundialShadow: sundial.getShadowLocation(),
    });
  }

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

  function clearStationData(): void {
    data.clear();
    interactions.clearAll();
    sundial.reset();
    scene.sundialLine.visible = false;
    scene.previewLine.visible = false;
  }
}
