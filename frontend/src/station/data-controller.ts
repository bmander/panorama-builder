// Per-station data: sync manager, orchestration handlers, CP visibility
// filter + cached marker / observation-ray / surface arrays, the global
// CP-constraint and CP-surface lists, other-station hydrated camera data,
// and the hydrate / clear / load lifecycle.
//
// External hooks: the controller receives callbacks for cross-controller
// concerns that don't belong in data (panel-derived getCapturedAt,
// stationFields.hydrate, settings.refreshSunDirection) and emits onRefresh
// so the caller can re-apply pose when caches change.

import * as THREE from 'three';
import * as api from '../api.js';
import type { ApiControlPoint, ApiHydratedWorld } from '../api.js';
import { cpLifespanFromApi, isExtantAt } from '../types.js';
import type { CPConstraintView, CPSurfaceView, ControlPointView, LatLng } from '../types.js';
import { dirFromAzAlt } from '../overlay.js';
import { azAltToPoint, groundDistance, vecToAzAlt } from '../geo.js';
import { degToRad } from '../mathx.js';
import { meanPhotoAzAlt } from '../station-navigation.js';
import { createSyncManager } from '../sync.js';
import type { SyncManager } from '../sync.js';
import { createOrchestration } from '../handlers.js';
import type { OrchestrationHandlers } from '../handlers.js';
import type { ControlPointColumn } from '../map-poi-columns.js';
import type { ObservationRay } from '../observation-rays.js';
import type { StationMarker } from '../station-markers.js';
import { FOCUS_FOV_DEG } from '../viewer.js';
import type { StationScene } from './scene.js';
import type { StationRouteState } from './route-state.js';

// Per-station cp_observation status, indexed by control_point_id. Drives
// both the visibility filter (non-`present` hides the marker) and POST vs
// PUT routing in the CP context menu — a stale `present` row from legacy
// data would 409 on POST, so we PUT when an id is known. `id: null` is the
// brief optimistic window between click and server ack.
export interface CpObservationCache {
  readonly id: string | null;
  readonly status: api.ApiCpObservationStatus;
}

// Hydrated per-photo data for every other station. Populated once via a
// batch of api.getStation calls; used to render frustum cones and to
// build observation rays for the currently-selected camera.
export interface OtherCameraMeasurement {
  readonly id: string;
  readonly u: number;
  readonly v: number;
  readonly controlPointId: string | null;
}

export interface OtherCamera {
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

export interface StationDataController {
  readonly sync: SyncManager;
  readonly handlers: OrchestrationHandlers;

  // Snapshot accessors — read by the pose-snapshot builder. Each returns the
  // same array reference until the underlying data changes, so renderer
  // fast-path equality checks fire.
  getCpConstraints(): readonly CPConstraintView[];
  getCpSurfaces(): readonly CPSurfaceView[];
  getCpMarkers(): readonly ControlPointColumn[];
  getVisibleCps(): readonly ControlPointView[];
  getObservationRays(): readonly ObservationRay[];
  getOtherStations(): readonly StationMarker[];
  getOtherCameras(): readonly OtherCamera[];

  // CP observation upsert. Optimistically updates the local cache + refreshes
  // visibility, then issues the POST/PUT (routed by whether a cp_observation
  // row already exists at this station). Rolls back the cache on failure.
  postCpObservation(cpId: string, status: api.ApiCpObservationStatus): Promise<void>;

  // CP observation delete. Optimistic cache clear + refresh, then DELETE.
  deleteCpObservation(cpId: string): Promise<void>;

  // Per-CP observation status at this station; null when no row exists.
  getCpObservationStatus(cpId: string): api.ApiCpObservationStatus | null;

  // Other-stations setter (used by station-navigation's fly post-update path).
  setOtherStations(stations: readonly StationMarker[]): void;

  // Visibility filter setters — settings panel writes these.
  // showUncited: include CPs with no cp_observation row at this station.
  // showAll:     superset — also include CPs marked absent or obscured.
  setShowUncitedCPs(v: boolean): void;
  setShowAllCPs(v: boolean): void;
  setCpMaxDistanceM(v: number | null): void;

  // Operations
  refreshControlPointColumns(): void;
  reloadCPConstraints(): Promise<void>;
  reloadCPSurfaces(): Promise<void>;
  registerControlPoint(cp: ApiControlPoint): void;

  // Single-shot camera anchor: sets station anchor + terrain + sun + flushes
  // sync. The refreshSunDirection callback is supplied at construction.
  applyCameraLocation(loc: LatLng, alt: number): void;

  // Reads the URL camera params and pumps them into viewer + worldCamera.
  // Called by load() after hydrate; popstate uses it directly on same-station
  // back/forward to restore a bookmarked viewpoint without re-hydrating.
  applyCameraFromURL(): void;

  // Lifecycle
  clear(): void;
  // Hydrates the station, runs onPostHydrate (callers use this to focus the
  // camera on a deep-linked CP/measurement before URL params override), then
  // applies URL camera + markLoaded. Returns early without applying camera /
  // markLoaded if the user navigated away during the hydrate fetch.
  load(id: string, prefetched?: ApiHydratedWorld, onPostHydrate?: () => void): Promise<void>;
  rehydrateAfterSolve(): Promise<void>;

  // Boot-time camera focus
  focusCameraOnControlPoint(id: string, fovDeg: number): boolean;
  focusCameraOnImageMeasurement(id: string): boolean;

  // Fade the loaded photo planes out to transparent (origin fade-out before a
  // fly-between) and back up to the opacity hydrate set (destination fade-in
  // after landing). Resolve when the tween completes.
  fadePhotosOut(durationMs: number): Promise<void>;
  fadePhotosIn(durationMs: number): Promise<void>;
}

export interface CreateStationDataControllerOptions {
  readonly scene: StationScene;
  readonly route: StationRouteState;
  // captured_at value (panel-derived, drives the lifespan filter in
  // getVisibleControlPoints).
  readonly getCapturedAt: () => string | null;
  // Called after the API station row lands; panel updates the form fields.
  readonly hydrateStationFields: (s: api.ApiStation) => void;
  // Re-runs the sun-direction setters from the panel.
  readonly refreshSunDirection: () => void;
  // Currently-selected other-station id, drives buildObservationRays.
  readonly getSelectedStationId: () => string | null;
  // Fires whenever a cache visible to the pose snapshot changes — caller
  // typically re-runs the pose pump so renderers see fresh data.
  readonly onRefresh: () => void;
}

// Reused empty array so the no-op guard inside observationRays.update
// catches refreshes when nothing is selected (the common case).
const EMPTY_RAYS: readonly ObservationRay[] = [];

export function createStationDataController(opts: CreateStationDataControllerOptions): StationDataController {
  const { scene, route, getCapturedAt, hydrateStationFields, refreshSunDirection, getSelectedStationId, onRefresh } = opts;
  const { overlays, worldCamera, viewer } = scene;

  const sync = createSyncManager({ overlays, getCurrentStationId: () => route.getStationId() });
  const handlers = createOrchestration({
    getCurrentStationId: () => route.getStationId(),
    overlays,
    sync,
  });

  // Loaded once at hydrate; mutated by reloadCPConstraints/Surfaces.
  let cpConstraints: CPConstraintView[] = [];
  let cpSurfaces: CPSurfaceView[] = [];

  let otherStations: readonly StationMarker[] = [];
  let otherCameras: readonly OtherCamera[] = [];

  // CP visibility filter flags.
  let showUncitedCPs = false;
  let showAllCPs = false;
  let cpMaxDistanceM: number | null = null;

  const cpObservationByCp = new Map<string, CpObservationCache>();

  // Caches whose array reference identity drives the renderer fast paths;
  // rebuilt only when underlying inputs change.
  let cachedObservationRays: readonly ObservationRay[] = EMPTY_RAYS;
  let cachedCpMarkers: readonly ControlPointColumn[] = [];
  let cachedVisibleCps: readonly ControlPointView[] = [];

  // CPs visible in the photo viewer. Same set drives column rendering and
  // the matcher hit-test, so what you see is what you can click. Lifespan
  // filter applies to non-observed CPs only.
  function getVisibleControlPoints(): ControlPointView[] {
    const capturedAt = getCapturedAt();
    const capturedMs = capturedAt !== null ? new Date(capturedAt).getTime() : null;
    const observed = new Set<string>();
    for (const im of overlays.measurements.list()) {
      if (im.controlPointId) observed.add(im.controlPointId);
    }
    const focusedCpId = route.getFocusedCpId();
    const maxD = cpMaxDistanceM;
    const camLoc = maxD !== null ? worldCamera.getPose().stationAnchor : null;
    return overlays.controlPoints.list().filter(cp => {
      if (cp.estLat === null || cp.estLng === null) return false;
      const forced = cp.id === focusedCpId;
      const isObserved = forced || observed.has(cp.id);
      const obs = cpObservationByCp.get(cp.id);
      // Uncited CPs need "show uncited" or "show all"; absent/obscured need "show all".
      if (!isObserved && obs && obs.status !== 'present' && !showAllCPs) return false;
      if (!isObserved && !obs && !showUncitedCPs && !showAllCPs) return false;
      if (capturedMs !== null && !isObserved && !isExtantAt(cp, capturedMs)) return false;
      if (maxD !== null && camLoc && !isObserved
          && groundDistance(camLoc, { lat: cp.estLat, lng: cp.estLng }) > maxD) {
        return false;
      }
      return true;
    });
  }

  function buildObservationRays(): readonly ObservationRay[] {
    const sel = getSelectedStationId();
    if (sel === null) return EMPTY_RAYS;
    const out: ObservationRay[] = [];
    for (const cam of otherCameras) {
      if (cam.stationId !== sel) continue;
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
    cachedCpMarkers = cps.map(cp => ({
      id: cp.id,
      anchor: { lat: cp.estLat!, lng: cp.estLng! },
      altitude: cp.estAlt,
      selected: cp.selected,
      status: cpObservationByCp.get(cp.id)?.status ?? null,
      observations: handlesByCpId.get(cp.id) ?? [],
    }));
    cachedVisibleCps = cps;
    cachedObservationRays = buildObservationRays();
    // CP locations may have changed — a CP gaining or losing a lat/lng
    // flips the orphan-visibility branch for its POIs.
    overlays.measurements.refreshVisibility();
    onRefresh();
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

  function mapApiCPConstraint(r: api.ApiCPConstraint): CPConstraintView {
    return { id: r.id, cpAId: r.cp_a_id, cpBId: r.cp_b_id, type: r.constraint_type };
  }

  async function reloadCPConstraints(): Promise<void> {
    try {
      cpConstraints = (await api.listCPConstraints()).map(mapApiCPConstraint);
    } catch (err) {
      console.error('list cp constraints failed:', err);
      cpConstraints = [];
    }
    refreshControlPointColumns();
  }

  function mapApiCPSurface(r: api.ApiCPSurface): CPSurfaceView {
    const ids = [r.cp_1_id, r.cp_2_id, r.cp_3_id];
    if (r.cp_4_id) ids.push(r.cp_4_id);
    return { id: r.id, cpIds: ids };
  }

  async function reloadCPSurfaces(): Promise<void> {
    try {
      cpSurfaces = (await api.listCPSurfaces()).map(mapApiCPSurface);
    } catch (err) {
      console.error('list cp surfaces failed:', err);
      cpSurfaces = [];
    }
    refreshControlPointColumns();
  }

  function applyCameraLocation(loc: LatLng, alt: number): void {
    worldCamera.setStationAnchor({ location: loc, altitudeMSL: alt });
    scene.pushTerrainFromPose();
    refreshSunDirection();
    sync.flush();
  }

  function applyCameraFromURL(): void {
    const snap = route.readCameraFromURL();
    if (snap.azDeg !== null && snap.altDeg !== null) {
      viewer.setAzAlt(degToRad(snap.azDeg), degToRad(snap.altDeg));
    }
    if (snap.fovDeg !== null) viewer.setFov(snap.fovDeg);
    if (snap.live) {
      worldCamera.setLiveCamera({
        location: { lat: snap.live.lat, lng: snap.live.lng },
        altitudeMSL: snap.live.altitudeMSL,
      });
    }
    viewer.requestRender();
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

  // Centers the camera on the CP and sets the FOV. Callers pass the FOV they
  // want: FOCUS_FOV_DEG for the deep-link focus, the flight's size-matched FOV
  // for a fly-to-CP landing.
  function focusCameraOnControlPoint(id: string, fovDeg: number): boolean {
    const cp = overlays.controlPoints.getById(id);
    if (cp?.estLat == null || cp.estLng == null || cp.estAlt == null) return false;
    const pose = worldCamera.getPose();
    if (!pose.location) return false;
    const { az, alt } = azAltToPoint(
      pose.location, pose.altitudeMSL, { lat: cp.estLat, lng: cp.estLng }, cp.estAlt);
    viewer.setAzAlt(az, alt);
    viewer.setFov(fovDeg);
    return true;
  }

  function photoGroups(): THREE.Group[] {
    return overlays.photos.list().filter((o): o is THREE.Group => o instanceof THREE.Group);
  }

  // Linearly tween each photo's opacity from `from[i]` to `to[i]` over
  // durationMs, repainting each frame. Resolves when the tween completes.
  function tweenPhotoOpacity(
    photos: readonly THREE.Group[], from: readonly number[], to: readonly number[], durationMs: number,
  ): Promise<void> {
    if (photos.length === 0) return Promise.resolve();
    return new Promise(resolve => {
      const start = performance.now();
      function step(now: number): void {
        const t = Math.min(1, (now - start) / durationMs);
        for (let i = 0; i < photos.length; i++) {
          overlays.photos.setOpacity(photos[i]!, from[i]! + (to[i]! - from[i]!) * t);
        }
        viewer.requestRender();
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  // Fade every loaded photo to transparent — the origin fade-out at the start
  // of a fly-between.
  function fadePhotosOut(durationMs: number): Promise<void> {
    const photos = photoGroups();
    return tweenPhotoOpacity(photos, photos.map(o => overlays.photos.getOpacity(o)),
      photos.map(() => 0), durationMs);
  }

  // Drop every loaded photo to transparent, then ramp back to each photo's
  // current opacity — the destination fade-in after landing. The drop is
  // synchronous so no full-opacity frame paints before the ramp's first tick.
  function fadePhotosIn(durationMs: number): Promise<void> {
    const photos = photoGroups();
    const target = photos.map(o => overlays.photos.getOpacity(o));
    for (const o of photos) overlays.photos.setOpacity(o, 0);
    return tweenPhotoOpacity(photos, photos.map(() => 0), target, durationMs);
  }

  function clear(): void {
    // Reset sync FIRST. The overlay teardown below removes every photo /
    // measurement / CP, each of which queues a notify; the batch's
    // onMutate then runs sync.flush, and a still-loaded sync would diff
    // the empty overlay state against its baseline and DELETE the
    // backend rows for the station we're leaving.
    sync.reset();
    overlays.withBatch(() => {
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
    cpConstraints = [];
    cpSurfaces = [];
    cpObservationByCp.clear();
    worldCamera.clear();
  }

  // Every other station's photos as frustum-cone / observation-ray sources,
  // built from the single world payload — replacing the per-station getStation
  // fan-out. Photos whose station is missing from the payload are skipped.
  function buildOtherCameras(world: ApiHydratedWorld, focusId: string): OtherCamera[] {
    const stationById = new Map(world.stations.map(st => [st.id, st]));
    const measByPhotoId = new Map<string, OtherCameraMeasurement[]>();
    for (const im of world.image_measurements) {
      const arr = measByPhotoId.get(im.photo_id) ?? [];
      arr.push({ id: im.id, u: im.u, v: im.v, controlPointId: im.control_point_id });
      measByPhotoId.set(im.photo_id, arr);
    }
    const cams: OtherCamera[] = [];
    for (const p of world.photos) {
      if (p.station_id === focusId) continue;
      const st = stationById.get(p.station_id);
      if (!st) continue;
      cams.push({
        stationId: p.station_id,
        photoId: p.id,
        fromLat: st.lat, fromLng: st.lng, fromAlt: st.alt,
        photoAz: p.photo_az, photoTilt: p.photo_tilt, photoRoll: p.photo_roll,
        sizeRad: p.size_rad, aspect: p.aspect,
        measurements: measByPhotoId.get(p.id) ?? [],
      });
    }
    return cams;
  }

  async function hydrateFromAPI(id: string, prefetched?: ApiHydratedWorld): Promise<void> {
    let world: ApiHydratedWorld;
    if (prefetched) {
      world = prefetched;
    } else {
      try {
        world = await api.getWorldCached(id);
      } catch (err) {
        console.error('hydrate failed:', err);
        alert('Could not load this station.');
        return;
      }
      if (id !== route.getStationId()) return;  // user navigated away during fetch
    }
    const data = api.focusStationFromWorld(world, id);
    const loc: LatLng = { lat: data.station.lat, lng: data.station.lng };
    // Anchor pose up front so subsequent reads see current values. Terrain
    // setLocation is deferred to the end of hydrate so DEM/imagery tile
    // fetches queue behind photos + markers.
    worldCamera.setStationAnchor({ location: loc, altitudeMSL: data.station.alt });
    refreshSunDirection();
    sync.flush();
    hydrateStationFields(data.station);

    // Center the viewport on the mean of the station's photo directions — but
    // only on a fresh load. A fly landing arrives with prefetched dest data and
    // its animation already positioned the camera (CP-centered for a focus
    // fly); resetting to the mean here would make the camera visibly swing to
    // the station's default view and back when the post-hydrate focus re-aims
    // after the list fetch yields — the "blink" at the end of a fly-between.
    if (!prefetched) {
      const meanOrient = meanPhotoAzAlt(data.photos);
      if (meanOrient) viewer.setAzAlt(meanOrient.az, meanOrient.alt);
    }

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
        overlays.photos.setLocks(o, {
          lockPhotoAz: p.lock_photo_az, lockPhotoTilt: p.lock_photo_tilt,
          lockPhotoRoll: p.lock_photo_roll, lockSizeRad: p.lock_size_rad,
          lockDistK1: p.lock_dist_k1, lockDistK2: p.lock_dist_k2,
        });
        overlays.photos.setSigmas(o, {
          sigmaPhotoAz: p.sigma_photo_az ?? null,
          sigmaPhotoTilt: p.sigma_photo_tilt ?? null,
          sigmaPhotoRoll: p.sigma_photo_roll ?? null,
          sigmaSizeRad: p.sigma_size_rad ?? null,
          sigmaDistK1: p.sigma_dist_k1 ?? null,
          sigmaDistK2: p.sigma_dist_k2 ?? null,
        });
        sync.registerPhoto(p.id, {
          aspect: p.aspect, photo_az: p.photo_az, photo_tilt: p.photo_tilt,
          photo_roll: p.photo_roll, size_rad: p.size_rad,
          dist_k1: p.dist_k1, dist_k2: p.dist_k2,
        });
        const fullUrl = api.photoBlobUrl(p);
        const previewUrl = api.photoPreviewUrl(p);
        const setTex = (tex: THREE.Texture): void => { overlays.photos.setTexture(o, tex); };
        const onFullErr = (err: unknown): void => { console.error(`photo ${p.id} load failed:`, err); };
        const loadFull = (): void => { loader.load(fullUrl, setTex, undefined, onFullErr); };
        if (previewUrl) {
          loader.load(previewUrl, tex => { setTex(tex); loadFull(); }, undefined, loadFull);
        } else {
          loadFull();
        }
      }

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

      for (const o of data.cp_observations) {
        cpObservationByCp.set(o.control_point_id, { id: o.id, status: o.status });
      }
    });

    // The remaining scene state all comes from the same world payload — no
    // second round of list reads, no per-station getStation fan-out. Control
    // points were already registered from data.control_points (the global set)
    // in the batch above.
    cpConstraints = world.cp_constraints.map(mapApiCPConstraint);
    cpSurfaces = world.cp_surfaces.map(mapApiCPSurface);
    otherStations = world.stations
      .filter(st => st.id !== id)
      .map(st => ({ id: st.id, name: st.name, anchor: { lat: st.lat, lng: st.lng }, altitude: st.alt }));
    otherCameras = buildOtherCameras(world, id);
    refreshControlPointColumns();

    // Terrain last so its tile flood queues behind the photo blob loads above.
    scene.pushTerrainFromPose();
  }

  async function rehydrateAfterSolve(): Promise<void> {
    const data = await api.getStation(route.getStationId());
    hydrateStationFields(data.station);
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
        overlays.photos.setSigmas(o, {
          sigmaPhotoAz: p.sigma_photo_az ?? null,
          sigmaPhotoTilt: p.sigma_photo_tilt ?? null,
          sigmaPhotoRoll: p.sigma_photo_roll ?? null,
          sigmaSizeRad: p.sigma_size_rad ?? null,
          sigmaDistK1: p.sigma_dist_k1 ?? null,
          sigmaDistK2: p.sigma_dist_k2 ?? null,
        });
        sync.registerPhoto(p.id, {
          aspect: p.aspect, photo_az: p.photo_az, photo_tilt: p.photo_tilt,
          photo_roll: p.photo_roll, size_rad: p.size_rad,
          dist_k1: p.dist_k1, dist_k2: p.dist_k2,
        });
      }
      for (const cp of data.control_points) {
        syncControlPoint(cp);
      }
    });
  }

  async function load(id: string, prefetched?: ApiHydratedWorld, onPostHydrate?: () => void): Promise<void> {
    await hydrateFromAPI(id, prefetched);
    if (id !== route.getStationId()) return;
    if (onPostHydrate) onPostHydrate();
    applyCameraFromURL();
    sync.markLoaded();
  }

  async function postCpObservation(
    cpId: string,
    status: api.ApiCpObservationStatus,
  ): Promise<void> {
    const prior = cpObservationByCp.get(cpId);
    cpObservationByCp.set(cpId, { id: prior?.id ?? null, status });
    refreshControlPointColumns();
    try {
      const o: api.ApiCpObservation = prior?.id
        ? await api.updateCpObservation(prior.id, { status })
        : await api.createCpObservation(route.getStationId(), {
            control_point_id: cpId,
            status,
          });
      cpObservationByCp.set(cpId, { id: o.id, status: o.status });
    } catch (err: unknown) {
      console.error('cp_observation upsert failed:', err);
      if (prior) cpObservationByCp.set(cpId, prior);
      else cpObservationByCp.delete(cpId);
      refreshControlPointColumns();
      alert('Update failed — see console.');
    }
  }

  async function deleteCpObservation(cpId: string): Promise<void> {
    const prior = cpObservationByCp.get(cpId);
    if (!prior?.id) return;
    cpObservationByCp.delete(cpId);
    refreshControlPointColumns();
    try {
      await api.deleteCpObservation(prior.id);
    } catch (err: unknown) {
      console.error('cp_observation delete failed:', err);
      cpObservationByCp.set(cpId, prior);
      refreshControlPointColumns();
      alert('Delete failed — see console.');
    }
  }

  return {
    sync,
    handlers,
    getCpConstraints: () => cpConstraints,
    getCpSurfaces: () => cpSurfaces,
    getCpMarkers: () => cachedCpMarkers,
    getVisibleCps: () => cachedVisibleCps,
    getObservationRays: () => cachedObservationRays,
    getOtherStations: () => otherStations,
    getOtherCameras: () => otherCameras,
    postCpObservation,
    deleteCpObservation,
    getCpObservationStatus: (cpId: string) => cpObservationByCp.get(cpId)?.status ?? null,
    setOtherStations: (s) => { otherStations = [...s]; },
    setShowUncitedCPs: (v) => {
      if (v === showUncitedCPs) return;
      showUncitedCPs = v;
      refreshControlPointColumns();
    },
    setShowAllCPs: (v) => {
      if (v === showAllCPs) return;
      showAllCPs = v;
      refreshControlPointColumns();
    },
    setCpMaxDistanceM: (v) => {
      if (v === cpMaxDistanceM) return;
      cpMaxDistanceM = v;
      refreshControlPointColumns();
    },
    refreshControlPointColumns,
    reloadCPConstraints,
    reloadCPSurfaces,
    registerControlPoint,
    applyCameraLocation,
    applyCameraFromURL,
    clear,
    load,
    rehydrateAfterSolve,
    focusCameraOnControlPoint,
    focusCameraOnImageMeasurement,
    fadePhotosOut,
    fadePhotosIn,
  };
}
