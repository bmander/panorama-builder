// Index route: a Leaflet map of every station + located control point, plus
// the cross-station solve modal. No 3D viewer, no overlay manager — CP state
// is held in a local Map and only what the map needs to draw is forwarded
// through createMapView.

import * as api from './api.js';
import type { ApiControlPoint, ApiHydratedStation, ApiStation } from './api.js';
import { createMapView } from './map.js';
import type { MapView, MapViewState } from './map.js';
import { createSolveModal } from './solve-modal.js';
import { createStartStationModal } from './start-station-modal.js';
import { createObservationModal } from './observation-modal.js';
import { createTimeFilter } from './time-filter.js';
import { DEFAULT_SIZE_RAD } from './overlay.js';
import { attachHamburgerMenu } from './hamburger-menu.js';
import { nullCpRayBearingDeg } from './null-cp-rays.js';
import { readAspectRatio } from './handlers.js';
import {
  cpLifespanFromApi, getElement, lifespanOverlapsRange,
  nullableIntervalOverlapsRange, stationHref,
} from './types.js';
import { stationAutoLockFor } from './auto-lock.js';
import { createSessionPanel } from './session-panel.js';
import { sessionUndo, attachUndoKeybindings } from './session-undo.js';
import { editingActive } from './session-store.js';
import { createSolverPanel } from './solver-panel.js';
import type { Cone, ControlPointView, LatLng } from './types.js';

export interface MountIndexPageOptions {
  focusIndexControlPointId: string | null;
  focusIndexStationId: string | null;
}

// URL query keys for view state. Short to keep shareable links compact.
const URL_LAT = 'la';
const URL_LNG = 'lo';
const URL_ZOOM = 'z';
const URL_YEAR_START = 'y0';
const URL_YEAR_END = 'y1';

interface UrlState {
  view: MapViewState | null;
  yearStart: number | null;
  yearEnd: number | null;
}

function parseUrlState(): UrlState {
  const sp = new URLSearchParams(location.search);
  const lat = parseFloat(sp.get(URL_LAT) ?? '');
  const lng = parseFloat(sp.get(URL_LNG) ?? '');
  const zoom = parseFloat(sp.get(URL_ZOOM) ?? '');
  const yearStart = parseInt(sp.get(URL_YEAR_START) ?? '', 10);
  const yearEnd = parseInt(sp.get(URL_YEAR_END) ?? '', 10);
  const haveView =
    Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    Number.isFinite(lng) && Math.abs(lng) <= 180 &&
    Number.isFinite(zoom) && zoom >= 0 && zoom <= 24;
  return {
    view: haveView ? { lat, lng, zoom } : null,
    yearStart: Number.isFinite(yearStart) ? yearStart : null,
    yearEnd: Number.isFinite(yearEnd) ? yearEnd : null,
  };
}

function writeUrlState(patch: Partial<{
  view: MapViewState;
  yearStart: number;
  yearEnd: number;
}>): void {
  const url = new URL(location.href);
  const sp = url.searchParams;
  const desired: [string, string][] = [];
  if (patch.view) {
    desired.push([URL_LAT, patch.view.lat.toFixed(5)]);
    desired.push([URL_LNG, patch.view.lng.toFixed(5)]);
    desired.push([URL_ZOOM, String(patch.view.zoom)]);
  }
  if (patch.yearStart !== undefined) {
    desired.push([URL_YEAR_START, String(patch.yearStart)]);
  }
  if (patch.yearEnd !== undefined) {
    desired.push([URL_YEAR_END, String(patch.yearEnd)]);
  }
  const stale = desired.filter(([k, v]) => sp.get(k) !== v);
  if (stale.length === 0) return;
  for (const [k, v] of stale) sp.set(k, v);
  history.replaceState(null, '', url);
}

// Slider falls back to this when no entities have any dated bound yet.
const FALLBACK_BOUNDS = {
  minMs: Date.UTC(1855, 0, 1),
  maxMs: Date.UTC(2026, 11, 31),
};

export function mountIndexPage(opts: MountIndexPageOptions): void {
  const { focusIndexControlPointId, focusIndexStationId } = opts;

  // Local CP store — keyed by id, the source-of-truth for the map's CP layer.
  // The station route caches CPs in OverlayManager; index has no scene to
  // share with, so a flat Map is enough.
  const cpsById = new Map<string, ApiControlPoint>();
  // Station cache so slider drags re-filter without refetching. Cones are
  // pre-baked from the hydrated photos at fetch time.
  interface CachedStation {
    readonly station: ApiStation;
    readonly cones: readonly Cone[];
    // Matched (control_point_id != null) image-measurement count across
    // this station's photos — feeds the popup's per-station auto-lock.
    readonly matchedObsCount: number;
  }
  const stationsById = new Map<string, CachedStation>();
  // CPs observed by the currently-previewed station. These bypass the time
  // filter so clicking a station marker surfaces every CP it touches, even
  // ones whose lifespan excludes the slider range.
  let previewObservedCpIds: ReadonlySet<string> = new Set();
  // CP whose popup is currently open. Pinned into the visible layer so the
  // marker stays drawn after the station-preview override that surfaced it
  // is dropped. Seeded from ?cp=<id> so the deep-linked CP survives the
  // initial refresh (which would otherwise drop it under showCps=false).
  let focusedCpId: string | null = focusIndexControlPointId;
  // Master toggle: when off, the CP layer is empty except for preview
  // overrides. Persisted across reloads via localStorage.
  const INDEX_SHOW_CPS_KEY = 'panorama:index-show-cps';
  let showCps = localStorage.getItem(INDEX_SHOW_CPS_KEY) === '1';

  function refreshIndexControlPoints(): void {
    const { startMs, endMs } = timeFilter.getRange();
    const dots = [];
    for (const cp of cpsById.values()) {
      if (cp.est_lat === null || cp.est_lng === null) continue;
      const observed = previewObservedCpIds.has(cp.id);
      const focused = focusedCpId === cp.id;
      const lifespan = cpLifespanFromApi(cp);
      if (!observed && !focused && (!showCps || !lifespanOverlapsRange(lifespan, startMs, endMs))) continue;
      dots.push({
        id: cp.id,
        latlng: { lat: cp.est_lat, lng: cp.est_lng },
        description: cp.description,
        alt: cp.est_alt,
        lockLat: cp.lock_est_lat,
        lockLng: cp.lock_est_lng,
        lockAlt: cp.lock_est_alt,
        sigmaLat: cp.sigma_est_lat ?? null,
        sigmaLng: cp.sigma_est_lng ?? null,
        covLatLng: cp.cov_est_lat_lng ?? null,
        lifespan,
      });
    }
    view.setIndexControlPoints(dots);
  }

  function refreshStationMarkers(): void {
    const { startMs, endMs } = timeFilter.getRange();
    const markers = [];
    for (const { station: st, cones, matchedObsCount } of stationsById.values()) {
      const w = st.derived_window;
      if (!nullableIntervalOverlapsRange(w.captured_at_lower, w.captured_at_upper, startMs, endMs)) continue;
      const auto = stationAutoLockFor(matchedObsCount);
      markers.push({
        id: st.id,
        latlng: { lat: st.lat, lng: st.lng },
        label: st.name ?? `Untitled ${st.id.slice(0, 6)}`,
        alt: st.alt,
        lockLat: st.lock_lat,
        lockLng: st.lock_lng,
        lockAlt: st.lock_alt,
        autoLockPos: auto.lat && auto.lng,
        autoLockAlt: auto.alt,
        sigmaLat: st.sigma_lat ?? null,
        sigmaLng: st.sigma_lng ?? null,
        covLatLng: st.cov_lat_lng ?? null,
        cones,
      });
    }
    view.setStationMarkers(markers);
  }

  async function showIndexControlPoints(): Promise<void> {
    try {
      const cps = await api.listControlPoints();
      cpsById.clear();
      for (const cp of cps) cpsById.set(cp.id, cp);
    } catch (err) {
      console.error('list control points failed:', err);
    }
    refreshIndexControlPoints();
  }

  async function loadStationMarkers(): Promise<void> {
    let stations: ApiStation[];
    try {
      stations = await api.listStations();
    } catch (err) {
      console.error('list stations failed:', err);
      return;
    }
    // Hydrate each station in parallel so the map icon can show every photo's
    // frustum wedge. Failures degrade to an empty cone list (the marker still
    // renders as a bare apex dot). With ~tens of stations this is fine; if it
    // grows we'd want a dedicated /api/stations endpoint that returns just
    // photo (id, photo_az, size_rad) tuples.
    const hydrated = await Promise.all(stations.map(async st => {
      try {
        return await api.getStation(st.id);
      } catch (err) {
        console.error(`hydrate station ${st.id} failed:`, err);
        return null;
      }
    }));
    stationsById.clear();
    stations.forEach((st, i) => {
      const h = hydrated[i];
      const cones: Cone[] = h
        ? h.photos.map(p => ({ azL: p.photo_az - p.size_rad / 2, azR: p.photo_az + p.size_rad / 2 }))
        : [];
      let matchedObsCount = 0;
      if (h) {
        for (const im of h.image_measurements) {
          if (im.control_point_id !== null) matchedObsCount++;
        }
      }
      stationsById.set(st.id, { station: st, cones, matchedObsCount });
    });
    refreshStationMarkers();
  }

  function applyDataBounds(): void {
    const stamps: number[] = [];
    const push = (s: string | null): void => {
      if (s === null) return;
      const t = new Date(s).getTime();
      if (Number.isFinite(t)) stamps.push(t);
    };
    for (const cp of cpsById.values()) {
      push(cp.derived_window.started_at_lower);
      push(cp.derived_window.ended_at_upper);
    }
    for (const { station } of stationsById.values()) {
      push(station.derived_window.captured_at_lower);
      push(station.derived_window.captured_at_upper);
    }
    if (stamps.length === 0) {
      timeFilter.setBounds(FALLBACK_BOUNDS);
      return;
    }
    timeFilter.setBounds({ minMs: Math.min(...stamps), maxMs: Math.max(...stamps) });
  }

  async function moveControlPointTo(id: string, latlng: LatLng): Promise<void> {
    if (!editingActive()) { refreshIndexControlPoints(); return; }
    try {
      const updated = await api.updateControlPoint(id, {
        est_lat: latlng.lat, est_lng: latlng.lng,
      });
      cpsById.set(updated.id, updated);
    } catch (err) {
      console.error('move control point failed:', err);
      alert('Move control point failed.');
    }
    // Re-render either way: success snaps to the canonical server lat/lng;
    // failure re-renders from the unchanged in-memory CP, snapping the dot back.
    refreshIndexControlPoints();
  }

  async function moveStationTo(id: string, latlng: LatLng): Promise<void> {
    if (!editingActive()) { await loadStationMarkers(); return; }
    try {
      await api.updateStation(id, { lat: latlng.lat, lng: latlng.lng });
    } catch (err) {
      console.error('move station failed:', err);
      alert('Move station failed.');
    }
    // Always re-render: success snaps to the canonical server lat/lng (in case
    // of rounding); failure reverts the marker to the unchanged server value.
    await loadStationMarkers();
  }

  async function updateStationLocks(id: string, patch: { lockPos?: boolean; lockAlt?: boolean }): Promise<void> {
    if (!editingActive()) { await loadStationMarkers(); return; }
    const body: api.StationUpdate = {};
    if (patch.lockPos !== undefined) { body.lock_lat = patch.lockPos; body.lock_lng = patch.lockPos; }
    if (patch.lockAlt !== undefined) body.lock_alt = patch.lockAlt;
    try {
      await api.updateStation(id, body);
    } catch (err) {
      console.error('update station locks failed:', err);
      alert('Update locks failed.');
    }
    // Re-render so the next popup open reads the canonical server value.
    await loadStationMarkers();
  }

  async function updateControlPointLocks(id: string, patch: { lockPos?: boolean; lockAlt?: boolean }): Promise<void> {
    if (!editingActive()) { refreshIndexControlPoints(); return; }
    const body: api.ControlPointPatch = {};
    if (patch.lockPos !== undefined) { body.lock_est_lat = patch.lockPos; body.lock_est_lng = patch.lockPos; }
    if (patch.lockAlt !== undefined) body.lock_est_alt = patch.lockAlt;
    try {
      const updated = await api.updateControlPoint(id, body);
      cpsById.set(updated.id, updated);
    } catch (err) {
      console.error('update control point locks failed:', err);
      alert('Update locks failed.');
    }
    refreshIndexControlPoints();
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
    const nullCpIds = new Set<string>();
    for (const cp of data.control_points) {
      if (cp.est_lat === null || cp.est_lng === null) nullCpIds.add(cp.id);
    }
    const photosById = new Map(data.photos.map(p => [p.id, p]));
    const nullCpRayBearingsDeg: number[] = [];
    for (const im of data.image_measurements) {
      if (im.control_point_id === null || !nullCpIds.has(im.control_point_id)) continue;
      const photo = photosById.get(im.photo_id);
      if (!photo) continue;
      nullCpRayBearingsDeg.push(nullCpRayBearingDeg(
        photo.photo_az, photo.photo_tilt, photo.photo_roll,
        photo.size_rad, photo.aspect, im.u, im.v,
      ));
    }
    previewObservedCpIds = observedCpIds;
    refreshIndexControlPoints();
    view.setStationPreview({
      stationId: id,
      origin: { lat: data.station.lat, lng: data.station.lng },
      cones,
      observedCpIds,
      nullCpRayBearingsDeg,
    });
  }

  async function onStartStationHere(
    input: { loc: LatLng; name: string; capturedAt: string | null; photos: readonly File[] },
  ): Promise<void> {
    const { loc, name, capturedAt, photos } = input;
    let created;
    try {
      created = await api.createStation(loc, capturedAt, name || undefined);
    } catch (err) {
      console.error('start station failed:', err);
      alert('Could not start station.');
      return;
    }

    const aspects: (number | null)[] = await Promise.all(photos.map(file =>
      readAspectRatio(file).catch((err: unknown) => {
        console.error(`decode of ${file.name} failed:`, err);
        return null;
      })
    ));

    const N = photos.length;
    const failed: string[] = [];
    for (let i = 0; i < N; i++) {
      const file = photos[i]!;
      const aspect = aspects[i];
      if (aspect == null) { failed.push(file.name); continue; }
      try {
        const az = (i / N) * 2 * Math.PI;
        const meta = {
          aspect, photo_az: az, photo_tilt: 0, photo_roll: 0,
          size_rad: DEFAULT_SIZE_RAD, opacity: 1,
        };
        const photo = await api.createPhoto(created.id, meta);
        await api.uploadPhotoBlob(photo.id, file);
      } catch (err) {
        console.error(`upload of ${file.name} failed:`, err);
        failed.push(file.name);
      }
    }
    if (failed.length > 0) {
      alert(`Some photos couldn't be uploaded: ${failed.join(', ')}.\nThe station was created without them.`);
    }

    location.assign(stationHref(created.id));
  }

  async function onCreateCPAtLocation(latlng: LatLng, description: string): Promise<void> {
    let cp: ApiControlPoint;
    try {
      cp = await api.createControlPoint({
        description,
        est_lat: latlng.lat,
        est_lng: latlng.lng,
        est_alt: null,
      });
    } catch (err) {
      console.error('add control point failed:', err);
      alert('Could not add control point.');
      return;
    }
    cpsById.set(cp.id, cp);
    // Select the new CP so it survives the showCps=false filter and gets a
    // popup; the focus filter at refreshIndexControlPoints keeps it visible
    // until the user dismisses the popup.
    focusedCpId = cp.id;
    refreshIndexControlPoints();
    view.focusIndexControlPoint(cp.id);
  }

  // The shared dropdown carries items for both routes; hide /world's.
  for (const id of ['settings-btn', 'sun-dial-btn', 'download']) {
    getElement(id).hidden = true;
  }
  getElement('index-show-cps-item').hidden = false;
  const showCpsCheckbox = getElement<HTMLInputElement>('index-show-cps');
  showCpsCheckbox.checked = showCps;
  showCpsCheckbox.addEventListener('change', () => {
    showCps = showCpsCheckbox.checked;
    if (showCps) localStorage.setItem(INDEX_SHOW_CPS_KEY, '1');
    else localStorage.removeItem(INDEX_SHOW_CPS_KEY);
    refreshIndexControlPoints();
  });
  attachHamburgerMenu();

  // Show the map container and instantiate Leaflet (the container must be
  // visible before L.map measures it, or tiles won't load at the right size).
  getElement('map-wrap').classList.add('show');
  const urlState = parseUrlState();
  const initialStart = urlState.yearStart !== null
    ? new Date(Date.UTC(urlState.yearStart, 0, 1)) : undefined;
  const initialEnd = urlState.yearEnd !== null
    ? new Date(Date.UTC(urlState.yearEnd, 11, 31)) : undefined;
  const timeFilter = createTimeFilter({
    initialStart,
    initialEnd,
    onChange: ({ startMs, endMs }) => {
      writeUrlState({
        yearStart: new Date(startMs).getFullYear(),
        yearEnd: new Date(endMs).getFullYear(),
      });
      refreshIndexControlPoints();
      refreshStationMarkers();
    },
  });
  timeFilter.setVisible(true);
  const startStationModal = createStartStationModal({
    onSubmit: input => onStartStationHere(input),
  });
  const observationModal = createObservationModal({
    getControlPoints: (): readonly ControlPointView[] => {
      const out: ControlPointView[] = [];
      for (const cp of cpsById.values()) {
        out.push({
          id: cp.id, description: cp.description,
          estLat: cp.est_lat, estLng: cp.est_lng, estAlt: cp.est_alt,
          ...cpLifespanFromApi(cp),
          selected: false,
        });
      }
      return out;
    },
    onPickExistingForMap: async (latlng, controlPointId) => {
      await moveControlPointTo(controlPointId, latlng);
    },
    onCreateMapAndObserve: async (latlng, description) => {
      await onCreateCPAtLocation(latlng, description);
    },
  });
  const view: MapView = createMapView({
    container: getElement('map'),
    onStationMarkerOpen: id => { location.assign(stationHref(id)); },
    onStationMarkerPreview: id => { void showStationPreview(id); },
    onStartStationHere: loc => { if (editingActive()) startStationModal.open(loc); },
    onAddControlPointHere: loc => { if (editingActive()) observationModal.openForMap(loc); },
    onStationMarkerMove: (id, latlng) => { void moveStationTo(id, latlng); },
    onControlPointMove: (id, latlng) => { void moveControlPointTo(id, latlng); },
    onStationLockChange: (id, patch) => { void updateStationLocks(id, patch); },
    onControlPointLockChange: (id, patch) => { void updateControlPointLocks(id, patch); },
    onPhotoDroppedOnMap: (latlng, files) => { if (editingActive()) startStationModal.open(latlng, files); },
    initialView: urlState.view ?? undefined,
    onViewChange: (v) => { writeUrlState({ view: v }); },
    onStationPreviewClose: () => {
      if (previewObservedCpIds.size === 0) return;
      previewObservedCpIds = new Set();
      // Defer to the next task: this callback fires from Leaflet's
      // popup auto-close during the `preclick` phase of a click event,
      // and rebuilding the CP layer synchronously removes the marker
      // before its `click` can dispatch — making the CP unselectable.
      setTimeout(refreshIndexControlPoints, 0);
    },
    onIndexControlPointFocus: (id) => {
      if (focusedCpId === id) return;
      focusedCpId = id;
      refreshIndexControlPoints();
    },
  });
  const refreshAfterSolve = (): Promise<void> =>
    Promise.all([loadStationMarkers(), showIndexControlPoints()])
      .then(applyDataBounds);
  const solveModal = createSolveModal({ onComplete: () => { void refreshAfterSolve(); } });
  const openJointSolve = (): void => {
    solveModal.open({ start: api.solveJointStream, title: 'Solve all (joint)' });
  };
  createSolverPanel(getElement('solver-host'), openJointSolve);
  sessionUndo.configure({
    rehydrate: refreshAfterSolve,
    reportError: (label, err) => { console.error(`${label}:`, err); },
  });
  attachUndoKeybindings();
  createSessionPanel(getElement('session-host'));
  const stationsReady = loadStationMarkers();
  const cpsReady = showIndexControlPoints();
  // Push data-driven slider bounds in once both fetches resolve. The slider
  // keeps the fallback bounds until then so it stays interactable during load.
  void Promise.all([stationsReady, cpsReady]).then(applyDataBounds);
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
