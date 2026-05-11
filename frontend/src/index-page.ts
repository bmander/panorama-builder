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
import { nullCpRayBearingDeg } from './null-cp-rays.js';
import { readAspectRatio } from './handlers.js';
import { cpLifespanFromApi, getElement, isExtantAt, stationHref } from './types.js';
import { createSessionPanel, createCommitLog } from './session-panel.js';
import type { ControlPointView, LatLng } from './types.js';

export interface MountIndexPageOptions {
  focusIndexControlPointId: string | null;
  focusIndexStationId: string | null;
}

// URL query keys for view state. Short to keep shareable links compact.
const URL_LAT = 'la';
const URL_LNG = 'lo';
const URL_ZOOM = 'z';
const URL_YEAR = 'y';

interface UrlState {
  view: MapViewState | null;
  year: number | null;
}

function parseUrlState(): UrlState {
  const sp = new URLSearchParams(location.search);
  const lat = parseFloat(sp.get(URL_LAT) ?? '');
  const lng = parseFloat(sp.get(URL_LNG) ?? '');
  const zoom = parseFloat(sp.get(URL_ZOOM) ?? '');
  const year = parseInt(sp.get(URL_YEAR) ?? '', 10);
  const haveView =
    Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    Number.isFinite(lng) && Math.abs(lng) <= 180 &&
    Number.isFinite(zoom) && zoom >= 0 && zoom <= 24;
  return {
    view: haveView ? { lat, lng, zoom } : null,
    year: Number.isFinite(year) ? year : null,
  };
}

function writeUrlState(patch: Partial<{ view: MapViewState; year: number }>): void {
  const url = new URL(location.href);
  const sp = url.searchParams;
  const desired: [string, string][] = [];
  if (patch.view) {
    desired.push([URL_LAT, patch.view.lat.toFixed(5)]);
    desired.push([URL_LNG, patch.view.lng.toFixed(5)]);
    desired.push([URL_ZOOM, String(patch.view.zoom)]);
  }
  if (patch.year !== undefined) {
    desired.push([URL_YEAR, String(patch.year)]);
  }
  const stale = desired.filter(([k, v]) => sp.get(k) !== v);
  if (stale.length === 0) return;
  for (const [k, v] of stale) sp.set(k, v);
  history.replaceState(null, '', url);
}

export function mountIndexPage(opts: MountIndexPageOptions): void {
  const { focusIndexControlPointId, focusIndexStationId } = opts;

  // Local CP store — keyed by id, the source-of-truth for the map's CP layer.
  // The station route caches CPs in OverlayManager; index has no scene to
  // share with, so a flat Map is enough.
  const cpsById = new Map<string, ApiControlPoint>();

  function refreshIndexControlPoints(): void {
    const filterMs = timeFilter.getTime().getTime();
    const dots = [];
    for (const cp of cpsById.values()) {
      if (cp.est_lat === null || cp.est_lng === null) continue;
      if (!isExtantAt(cpLifespanFromApi(cp), filterMs)) continue;
      dots.push({
        id: cp.id,
        latlng: { lat: cp.est_lat, lng: cp.est_lng },
        description: cp.description,
      });
    }
    view.setIndexControlPoints(dots);
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

  async function showStationMarkers(): Promise<void> {
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

  async function moveControlPointTo(id: string, latlng: LatLng): Promise<void> {
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
    try {
      await api.updateStation(id, { lat: latlng.lat, lng: latlng.lng });
    } catch (err) {
      console.error('move station failed:', err);
      alert('Move station failed.');
    }
    // Always re-render: success snaps to the canonical server lat/lng (in case
    // of rounding); failure reverts the marker to the unchanged server value.
    await showStationMarkers();
  }

  async function solveAndPersistControlPointLocation(id: string): Promise<void> {
    try {
      await api.solveControlPoint(id);
    } catch (err) {
      console.error('solve control point location failed:', err);
      alert('Solve control point location failed.');
      return;
    }
    // Re-fetch the CP and update local state. Backend writes the new est_*
    // fields atomically; reading back is the simplest way to mirror them.
    let updated: ApiControlPoint;
    try {
      updated = await api.getControlPoint(id);
    } catch (err) {
      console.error('reload control point after solve failed:', err);
      alert('Reload control point after solve failed.');
      return;
    }
    cpsById.set(updated.id, updated);
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
    view.setStationPreview({
      origin: { lat: data.station.lat, lng: data.station.lng },
      cones,
      observedCpIds,
      nullCpRayBearingsDeg,
    });
  }

  async function onStartStationHere(
    input: { loc: LatLng; name: string; capturedAt: string; photos: readonly File[] },
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
  }

  // Show the map container and instantiate Leaflet (the container must be
  // visible before L.map measures it, or tiles won't load at the right size).
  getElement('map-wrap').classList.add('show');
  const urlState = parseUrlState();
  const initialDate = new Date();
  if (urlState.year !== null) initialDate.setFullYear(urlState.year);
  const timeFilter = createTimeFilter({
    initial: initialDate,
    onChange: (t) => {
      writeUrlState({ year: t.getFullYear() });
      refreshIndexControlPoints();
    },
  });
  timeFilter.setVisible(true);
  writeUrlState({ year: timeFilter.getTime().getFullYear() });
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
      refreshIndexControlPoints();
    },
  });
  const view: MapView = createMapView({
    container: getElement('map'),
    onStationMarkerOpen: id => { location.assign(stationHref(id)); },
    onStationMarkerPreview: id => { void showStationPreview(id); },
    onStartStationHere: loc => { startStationModal.open(loc); },
    onAddControlPointHere: loc => { observationModal.openForMap(loc); },
    onControlPointSolveLocation: id => { void solveAndPersistControlPointLocation(id); },
    onStationMarkerMove: (id, latlng) => { void moveStationTo(id, latlng); },
    onControlPointMove: (id, latlng) => { void moveControlPointTo(id, latlng); },
    onPhotoDroppedOnMap: (latlng, files) => { startStationModal.open(latlng, files); },
    initialView: urlState.view ?? undefined,
    onViewChange: (v) => { writeUrlState({ view: v }); },
  });
  const solveModal = createSolveModal({
    onComplete: (result, dryRun) => {
      if (dryRun || result.diverged) return;
      void showStationMarkers();
      void showIndexControlPoints();
    },
  });
  getElement('index-top-right').hidden = false;
  getElement<HTMLButtonElement>('index-solve-btn').addEventListener('click', () => {
    solveModal.open();
  });

  const sessionHost = getElement('session-host');
  createSessionPanel(sessionHost);
  createCommitLog(sessionHost);
  const stationsReady = showStationMarkers();
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
