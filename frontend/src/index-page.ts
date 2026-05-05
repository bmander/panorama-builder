// Index route: a Leaflet map of every station + located control point, plus
// the cross-station solve modal. No 3D viewer, no overlay manager — CP state
// is held in a local Map and only what the map needs to draw is forwarded
// through createMapView.

import * as api from './api.js';
import type { ApiControlPoint, ApiHydratedStation, ApiStation } from './api.js';
import { createMapView } from './map.js';
import type { MapView } from './map.js';
import { createSolveModal } from './solve-modal.js';
import { createStartStationModal } from './start-station-modal.js';
import { createObservationModal } from './observation-modal.js';
import { createTimeFilter } from './time-filter.js';
import { DEFAULT_SIZE_RAD } from './overlay.js';
import { readAspectRatio } from './handlers.js';
import { getElement, stationHref } from './types.js';
import type { ControlPointView, LatLng } from './types.js';

export interface MountIndexPageOptions {
  focusIndexControlPointId: string | null;
  focusIndexStationId: string | null;
}

export function mountIndexPage(opts: MountIndexPageOptions): void {
  const { focusIndexControlPointId, focusIndexStationId } = opts;

  // Local CP store — keyed by id, the source-of-truth for the map's CP layer.
  // The station route caches CPs in OverlayManager; index has no scene to
  // share with, so a flat Map is enough.
  const cpsById = new Map<string, ApiControlPoint>();

  // A CP is extant at time t when t falls within [started_at, ended_at].
  // Either bound being null means "unknown / open-ended", which always
  // satisfies that side — so a CP with both nulls always passes.
  function isExtantAt(cp: ApiControlPoint, ms: number): boolean {
    if (cp.started_at !== null && new Date(cp.started_at).getTime() > ms) return false;
    if (cp.ended_at !== null && new Date(cp.ended_at).getTime() < ms) return false;
    return true;
  }

  function refreshIndexControlPoints(): void {
    const filterMs = timeFilter.getTime().getTime();
    const dots = [];
    for (const cp of cpsById.values()) {
      if (cp.est_lat === null || cp.est_lng === null) continue;
      if (!isExtantAt(cp, filterMs)) continue;
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
    view.setStationPreview({
      origin: { lat: data.station.lat, lng: data.station.lng },
      cones,
      observedCpIds,
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

  async function onCreateCPAtLocation(latlng: LatLng, description: string, estAlt: number | null): Promise<void> {
    let cp: ApiControlPoint;
    try {
      cp = await api.createControlPoint({
        description,
        est_lat: latlng.lat,
        est_lng: latlng.lng,
        // est_alt is NOT NULL in the DB; default to 0 when the DEM lookup
        // failed so the column always has a value (the user can refine via the
        // CP page).
        est_alt: estAlt ?? 0,
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
  const timeFilter = createTimeFilter({
    initial: new Date(),
    onChange: () => { refreshIndexControlPoints(); },
  });
  timeFilter.setVisible(true);
  const startStationModal = createStartStationModal({
    onSubmit: input => onStartStationHere(input),
  });
  const observationModal = createObservationModal({
    getControlPoints: (): readonly ControlPointView[] => {
      // observationModal only renders the list when image-mode is active,
      // which the index route never opens — so this is just a safety stub.
      return [];
    },
    onCreateMapAndObserve: async (latlng, description, estAlt) => {
      await onCreateCPAtLocation(latlng, description, estAlt);
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
