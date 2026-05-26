// All panel + modal construction for the station view: session panel,
// settings, admin, CP-constraint / CP-surface modals, context menu,
// observation modal, photo HUD, undo manager, station fields, station
// navigation, solve actions. Also wires the hamburger menu, the
// PNG-download anchor, and the params-panel collapse block.
//
// Panel callbacks that need to reach back into interactions (modal onClose
// handlers, mostly) arrive as opts.onX hooks; station-page.ts supplies them
// as closures over the (later-declared) interactions binding.

import type { ApiHydratedWorld } from '../api.js';
import { attachDownload } from '../ui.js';
import { createCPConstraintModal } from '../cp-constraint-modal.js';
import { createCPSurfaceModal } from '../cp-surface-modal.js';
import { getElement } from '../types.js';
import type { CPConstraintView } from '../types.js';
import { createSessionPanel } from '../session-panel.js';
import type { SessionPanel } from '../session-panel.js';
import { createSettingsPanel } from '../settings.js';
import type { SettingsPanel } from '../settings.js';
import { createAdminModal } from '../admin-modal.js';
import type { AdminModal } from '../admin-modal.js';
import { attachHamburgerMenu } from '../hamburger-menu.js';
import { createContextMenu } from '../context-menu.js';
import type { ContextMenu } from '../context-menu.js';
import { createObservationModal } from '../observation-modal.js';
import type { ObservationModal } from '../observation-modal.js';
import { createPhotoHud } from '../photo-hud.js';
import type { PhotoHud } from '../photo-hud.js';
import { createUndoManager } from '../undo.js';
import type { UndoManager } from '../undo.js';
import { createStationNavigation } from '../station-navigation.js';
import type { CpFlightFocus, StationNavigation } from '../station-navigation.js';
import { createStationFields } from '../station-fields.js';
import type { StationFieldsHandle } from '../station-fields.js';
import { photoAutoLockFor, stationAutoLockFor } from '../auto-lock.js';
import type { PhotoAutoLock, StationAutoLock } from '../auto-lock.js';
import { editingActive } from '../session-store.js';
import { attachSolveActions } from '../solve-actions.js';
import { createSolverPanel } from '../solver-panel.js';
import type { StationScene } from './scene.js';
import type { StationDataController } from './data-controller.js';
import type { StationRouteState } from './route-state.js';

export interface StationPanels {
  readonly sessionPanel: SessionPanel;
  readonly settings: SettingsPanel;
  readonly admin: AdminModal;
  readonly contextMenu: ContextMenu;
  readonly observationModal: ObservationModal;
  readonly photoHud: PhotoHud;
  readonly undoManager: UndoManager;
  readonly stationFields: StationFieldsHandle;
  readonly stationNavigation: StationNavigation;
  // Modal-open actions. The cp-constraint / cp-surface modals themselves are
  // panel-internal — callers open them via these delegated methods so the
  // modal handles don't leak into the public surface.
  openConstraintCreate(cpAId: string, cpBId: string): void;
  openConstraintEdit(c: CPConstraintView): void;
  openSurfaceEdit(surfaceId: string): void;
}

export interface CreateStationPanelsOptions {
  readonly scene: StationScene;
  readonly data: StationDataController;
  readonly route: StationRouteState;
  // Modal onClose / onMutated selection-clear hooks. Lazy: station-page.ts
  // passes closures over the (later-declared) interactions binding.
  readonly onCpConstraintMutated: () => void;
  readonly onCpConstraintClose: () => void;
  readonly onCpSurfaceMutated: () => void;
  readonly onCpSurfaceClose: () => void;
  // Forward-ref to the composition root's loadStation helper. Used by
  // station-navigation's fly-to flow. focus centers + zooms a control point
  // once the destination station hydrates.
  readonly loadStation: (
    id: string, prefetched?: ApiHydratedWorld, focus?: CpFlightFocus | null,
  ) => Promise<void>;
}

export function createStationPanels(opts: CreateStationPanelsOptions): StationPanels {
  const { scene, data, route } = opts;
  const { viewer, overlays, worldCamera, terrain, sky, sunMarker, baker, cpSurfacesRenderer } = scene;
  const { sync } = data;

  const solveActions = attachSolveActions({
    rehydrate: () => data.rehydrateAfterSolve(),
    reportError: (label, err) => { sync.reportError(label, err); },
  });
  createSolverPanel(getElement('solver-host'), () => { solveActions.open(); });

  const sessionPanel = createSessionPanel(getElement('session-host'));

  const settings = createSettingsPanel({
    viewer, terrain, sunMarker, sky,
    getCameraLocation: () => worldCamera.getPose().stationAnchor,
    onCpMaxDistanceChange: meters => { data.setCpMaxDistanceM(meters); },
    onSurfaceOpacityChange: opacity => { cpSurfacesRenderer.setOpacity(opacity); },
  });

  // CP visibility toggles — persisted across reloads.
  function wireCheckbox(
    itemId: string, inputId: string, storageKey: string,
    push: (v: boolean) => void,
  ): void {
    getElement(itemId).hidden = false;
    const el = getElement<HTMLInputElement>(inputId);
    const initial = localStorage.getItem(storageKey) === '1';
    el.checked = initial;
    // Deferred: data's getCapturedAt closure reaches back through
    // panels.stationFields, which doesn't exist until createStationPanels
    // returns. A microtask waits for both bindings.
    if (initial) queueMicrotask(() => { push(initial); });
    el.addEventListener('change', () => {
      const v = el.checked;
      if (v) localStorage.setItem(storageKey, '1');
      else localStorage.removeItem(storageKey);
      push(v);
    });
  }
  wireCheckbox('cp-show-uncited-item', 'cp-show-uncited',
    'panorama:cp-show-uncited', v => { data.setShowUncitedCPs(v); });
  wireCheckbox('cp-show-all-item', 'cp-show-all',
    'panorama:cp-show-all', v => { data.setShowAllCPs(v); });

  const admin = createAdminModal({ getCurrentStationId: () => route.getStationId() });

  const cpConstraintModal = createCPConstraintModal({
    getControlPoints: () => overlays.controlPoints.list(),
    onMutated: () => {
      opts.onCpConstraintMutated();
      void data.reloadCPConstraints();
    },
    onClose: () => { opts.onCpConstraintClose(); },
  });

  const cpSurfaceModal = createCPSurfaceModal({
    onMutated: () => {
      opts.onCpSurfaceMutated();
      void data.reloadCPSurfaces();
    },
    onClose: () => { opts.onCpSurfaceClose(); },
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

  const contextMenu = createContextMenu();
  const undoManager = createUndoManager({
    overlays, sync,
    reportError: (label, err) => { sync.reportError(label, err); },
  });

  // The station view only loads the active station's photos +
  // measurements, so the per-station total is just the loaded set —
  // no station-id filter needed.
  const getPhotoAutoLock = (photoId: string): PhotoAutoLock =>
    photoAutoLockFor(overlays.measurements.matchedCountByPhoto().get(photoId) ?? 0);
  const getStationAutoLock = (): StationAutoLock =>
    stationAutoLockFor(overlays.measurements.matchedCount());

  const photoHud = createPhotoHud({
    overlays, sync, undoManager, getPhotoAutoLock,
  });
  const observationModal = createObservationModal({
    getControlPoints: () => overlays.controlPoints.list(),
    onPickExisting: (overlay, u, v, controlPointId) => {
      void data.handlers.onMatchImageMeasurement(overlay, u, v, controlPointId);
    },
    onCreateAndObserve: (overlay, u, v, description) =>
      data.handlers.onCreateCPAndObserve(overlay, u, v, description),
  });

  const stationFields = createStationFields({
    getCurrentStationId: () => route.getStationId(),
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
      if (pose.stationAltitudeMSL === null) return;
      data.applyCameraLocation(loc, pose.stationAltitudeMSL);
    },
    getStationAutoLock,
  });

  const stationNavigation = createStationNavigation({
    viewer, terrain,
    worldCamera,
    getCurrentStationId: () => route.getStationId(),
    getStationName: () => stationFields.getNameAndAlt()?.name ?? null,
    getOtherStations: () => data.getOtherStations(),
    setOtherStations: (s) => { data.setOtherStations(s); },
    fadePhotosOut: (ms) => data.fadePhotosOut(ms),
    fadePhotosIn: (ms) => data.fadePhotosIn(ms),
    loadStation: opts.loadStation,
  });

  attachDownload({ baker });

  return {
    sessionPanel, settings, admin,
    contextMenu, observationModal,
    photoHud, undoManager,
    stationFields, stationNavigation,
    openConstraintCreate: (a, b) => { if (editingActive()) cpConstraintModal.openCreate(a, b); },
    openConstraintEdit: (c) => { if (editingActive()) cpConstraintModal.openEdit(c); },
    openSurfaceEdit: (id) => { if (editingActive()) cpSurfaceModal.open(id); },
  };
}
