// Selection state + input wiring for the station view. Owns selectedX state,
// the multi-select constraint workflow, the CP context-menu builder, and
// the full attachInput callback bag.
//
// panels is held via closure — it's constructed *after* interactions in the
// composition root so its modal onClose handlers can reach back into
// interactions.clearXSelection.

import * as api from '../api.js';
import { attachInput } from '../input.js';
import type { PhotoBodyHit } from '../input.js';
import { findHitColumn } from '../map-poi-columns.js';
import { findHitDot } from '../dot-layer.js';
import {
  cpHref, cpLabel, formatLifespanLines, getElement, overlayData, poiData,
} from '../types.js';
import { latLngToCameraRelativeMeters, tangentMetersToLatLng } from '../geo.js';
import { vertexToLatLngAlt } from '../camera-anchored.js';
import { radToDeg } from '../mathx.js';
import { dirFromAzAlt } from '../overlay.js';
import { locEq } from '../world-camera.js';
import { triggerDownloadUrl } from '../ui.js';
import type { ContextMenuItem } from '../context-menu.js';
import { editingActive } from '../session-store.js';
import type { StationScene } from './scene.js';
import type { StationDataController } from './data-controller.js';
import type { StationRouteState } from './route-state.js';
import type { SundialController } from './sundial-controller.js';
import type { StationPanels } from './panels.js';

const SHIFT_WHEEL_LOG_PER_PX = 0.005;
const COLUMN_NDC_HIT_RADIUS = 0.01;
const STATION_DOT_HIT_PX = 10;

export interface StationInteractions {
  getSelectedStationId(): string | null;
  getSelectedConstraintId(): string | null;
  getMultiSelectedConstraintIds(): ReadonlySet<string>;
  getSelectedSurfaceId(): string | null;
  // Modal onClose hooks call these to drop the selection that was opened
  // alongside the modal.
  clearConstraintSelection(): void;
  clearSurfaceSelection(): void;
  clearMultiSelectedConstraints(): void;
  // Station-swap clear path.
  clearAll(): void;
}

export interface CreateStationInteractionsOptions {
  readonly scene: StationScene;
  readonly data: StationDataController;
  readonly route: StationRouteState;
  readonly sundial: SundialController;
  // panels is constructed *after* interactions in station-page.ts (so its
  // modal onClose handlers can call back into interactions.clearXSelection);
  // we receive it as a forward-ref binding via closure.
  readonly panels: StationPanels;
}

// Modal-style file picker for menu actions ("Replace image…"). Resolves with
// the chosen File or null on cancel.
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

export function createStationInteractions(opts: CreateStationInteractionsOptions): StationInteractions {
  const { scene, data, route, sundial, panels } = opts;
  const {
    viewer, overlays, worldCamera, terrain,
    cpColumns, cpConstraintLines, cpSurfacesRenderer,
    hud, previewLine, previewPositions,
  } = scene;

  let selectedConstraintId: string | null = null;
  let multiSelectedConstraintIds: ReadonlySet<string> = new Set();
  let selectedSurfaceId: string | null = null;
  let selectedStationId: string | null = null;

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
    cpConstraintLines.update(pose.location, pose.altitudeMSL,
      data.getVisibleCps(), data.getCpConstraints(),
      selectedConstraintId, multiSelectedConstraintIds);
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

  function openCpContextMenu(
    cpId: string, sx: number, sy: number, body: PhotoBodyHit | null,
  ): void {
    const cp = overlays.controlPoints.getById(cpId);
    const header = cpLabel(cp?.description ?? '');
    const info = cp ? formatLifespanLines(cp) : undefined;
    // Selecting one of the CP's measurements reveals every reticule that
    // shares the CP on this station, so the user can see the full match.
    const ownMeasurements = overlays.measurements.list()
      .filter(im => im.controlPointId === cpId);
    if (ownMeasurements.length > 0) {
      overlays.measurements.setSelected(ownMeasurements[0]!.handle);
    }
    const stationObserves = ownMeasurements.length > 0;
    const selected = stationObserves ? 'present' : data.getCpObservationStatus(cpId);

    // Network-independent items, rebuilt on re-open so the spliced-in "Zoom
    // to…" section sits above them. Nudge the menu right so the CP marker (and
    // the reticules just revealed above) stay uncovered.
    function baseItems(): ContextMenuItem[] {
      const items: ContextMenuItem[] = [
        { label: 'View control point →', onClick: () => { location.assign(cpHref(cpId)); } },
      ];
      if (editingActive()) {
        items.push({
          kind: 'radio-group',
          legend: 'Visibility',
          options: [
            { value: 'present',  label: 'Present',  disabled: stationObserves || !body },
            { value: 'absent',   label: 'Absent',   disabled: stationObserves },
            { value: 'obscured', label: 'Obscured', disabled: stationObserves },
          ],
          selected,
          onChange: (next) => {
            if (next === null) {
              void data.deleteCpObservation(cpId);
              return;
            }
            if (next === 'present') {
              void data.handlers.onMatchImageMeasurement(body!.overlay, body!.u, body!.v, cpId);
              return;
            }
            void data.postCpObservation(cpId, next as api.ApiCpObservationStatus);
          },
        });
      }
      return items;
    }
    panels.contextMenu.open(sx + 20, sy, baseItems(), header, info);

    // "Zoom to…" — the other stations observing this CP. Fetched from the
    // dedicated server-side join (one request, complete) rather than the
    // per-station getStation fan-out, which silently drops stations whose
    // fetch fails under the world-view's request load. Only when the CP has a
    // full 3D estimate (with unknown elevation the fly can't aim at it).
    const canFocus = cp?.estLat != null && cp.estLng != null && cp.estAlt != null;
    if (!canFocus) return;
    const menuGen = panels.contextMenu.generation();
    void api.listControlPointObservations(cpId).then(obs => {
      // Bail if the menu was closed or replaced while the fetch was in flight.
      if (panels.contextMenu.generation() !== menuGen) return;
      const here = route.getStationId();
      const nameByStation = new Map<string, string | null>();
      for (const im of obs.image_measurements) {
        if (im.station_id !== here) nameByStation.set(im.station_id, im.station_name);
      }
      if (nameByStation.size === 0) return;
      const options = [...nameByStation]
        .sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? ''))
        .map(([stId, name]) => ({ value: stId, label: name ?? `Untitled ${stId.slice(0, 6)}` }));
      const zoom: ContextMenuItem = {
        kind: 'dropdown',
        label: 'Zoom to…',
        options,
        onSelect: stId => { void panels.stationNavigation.flyToStation(stId, cpId); },
      };
      panels.contextMenu.open(sx + 20, sy, [zoom, ...baseItems()], header, info);
    }).catch((err: unknown) => { console.error('list cp observations failed:', err); });
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
      panels.photoHud.refresh();
      writeCameraToURL();
    },
    onPhotoDropped: (tex, blob, aspect, dir, revokeUrl) => {
      if (!editingActive()) { revokeUrl(); return; }
      void data.handlers.onPhotoDropped(tex, blob, aspect, dir, revokeUrl);
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
      const photoId = overlayData(overlay).id;
      const items: ContextMenuItem[] = [];
      if (editingActive()) {
        items.push(
          { label: 'Add observation here', onClick: () => { panels.observationModal.open(overlay, u, v); } },
          { label: 'Replace image…', onClick: () => {
            void pickImageFile().then(file => {
              if (file) void data.handlers.onReplacePhoto(overlay, file);
            });
          } },
        );
      }
      items.push({ label: 'Download image', onClick: () => {
        triggerDownloadUrl(`panorama-photo-${photoId}.jpg`,
          api.photoBlobUrl({ id: photoId, blob_path: null }));
      } });
      panels.contextMenu.open(sx, sy, items);
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
      panels.contextMenu.open(sx, sy, [
        { label: 'Go to camera →', onClick: () => { void panels.stationNavigation.flyToStation(id); } },
      ], header);
    },
    onDeselectStation: () => {
      if (selectedStationId === null) return;
      selectedStationId = null;
      data.refreshControlPointColumns();
    },
    onCPClick: (cpId, sx, sy, body) => {
      if (sundial.getActivePicker() === 'gnomon') {
        sundial.onGnomonPicked(cpId);
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
      panels.openConstraintEdit(constraint);
    },
    findSurfaceAtNDC: ndc => cpSurfacesRenderer.findHit(ndc, viewer.camera),
    onSurfaceClick: (surfaceId, _sx, _sy, point) => {
      if (sundial.getActivePicker() === 'shadow') {
        const pose = worldCamera.getPose();
        if (pose.location) {
          sundial.onShadowPicked(surfaceId, vertexToLatLngAlt(point, pose.location, pose.altitudeMSL));
        }
        return;
      }
      selectedSurfaceId = surfaceId;
      data.refreshControlPointColumns();
      panels.openSurfaceEdit(surfaceId);
    },
    onCreateCPConstraint: (cpAId, cpBId) => { panels.openConstraintCreate(cpAId, cpBId); },
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
    undoManager: panels.undoManager,
  });

  return {
    getSelectedStationId: () => selectedStationId,
    getSelectedConstraintId: () => selectedConstraintId,
    getMultiSelectedConstraintIds: () => multiSelectedConstraintIds,
    getSelectedSurfaceId: () => selectedSurfaceId,
    clearConstraintSelection: () => {
      if (selectedConstraintId === null) return;
      selectedConstraintId = null;
      data.refreshControlPointColumns();
    },
    clearSurfaceSelection: () => {
      if (selectedSurfaceId === null) return;
      selectedSurfaceId = null;
      data.refreshControlPointColumns();
    },
    clearMultiSelectedConstraints,
    clearAll: () => {
      selectedStationId = null;
      selectedConstraintId = null;
      selectedSurfaceId = null;
      clearMultiSelectedConstraints();
    },
  };
}
