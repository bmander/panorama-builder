// Diff-based sync between the in-memory scene and the backend. Mutations
// trigger flush(); flush() snapshots the current scene state, diffs against
// our local `synced` cache, and issues PUT/POST/DELETE for the differences.
// Cache writes are deferred until each API call resolves, so transient
// failures leave the cached value stale and the next diff retries them.

import * as THREE from 'three';
import * as api from './api.js';
import { getElement, overlayData } from './types.js';
import type { LatLng } from './types.js';
import type { OverlayManager } from './overlay.js';

export interface SyncedPhoto {
  aspect: number;
  photo_az: number;
  photo_tilt: number;
  photo_roll: number;
  size_rad: number;
  opacity: number;
}
export interface SyncedMapMeasurement { lat: number; lng: number; control_point_id: string | null; }
export interface SyncedImageMeasurement { u: number; v: number; control_point_id: string | null; }
export interface SyncedControlPoint {
  description: string;
  est_lat: number | null;
  est_lng: number | null;
  est_alt: number | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface SyncManager {
  registerLocation(loc: LatLng): void;
  registerPhoto(id: string, pose: SyncedPhoto): void;
  registerMapMeasurement(id: string, payload: SyncedMapMeasurement): void;
  registerImageMeasurement(id: string, payload: SyncedImageMeasurement): void;
  registerControlPoint(id: string, payload: SyncedControlPoint): void;
  flush(): void;
  markLoaded(): void;
  reportError(label: string, err: unknown): void;
}

export interface CreateSyncManagerOptions {
  overlays: OverlayManager;
  getCurrentStationId: () => string | null;
  getCameraLocation: () => LatLng | null;
}

export function createSyncManager({
  overlays, getCurrentStationId, getCameraLocation,
}: CreateSyncManagerOptions): SyncManager {
  interface SyncedLocation { lat: number; lng: number; }
  const synced = {
    location: null as SyncedLocation | null,
    photos: new Map<string, SyncedPhoto>(),
    mapMeasurements: new Map<string, SyncedMapMeasurement>(),
    imageMeasurements: new Map<string, SyncedImageMeasurement>(),
    controlPoints: new Map<string, SyncedControlPoint>(),
  };

  let loaded = false;
  let flushing = false;
  let flushPending = false;

  const errorEl = getElement('save-error');
  const errorMsgEl = getElement('save-error-msg');
  const errorRetryEl = getElement<HTMLButtonElement>('save-error-retry');
  function showError(msg: string): void {
    errorMsgEl.textContent = msg;
    errorEl.hidden = false;
  }
  function hideError(): void { errorEl.hidden = true; }
  errorRetryEl.addEventListener('click', () => {
    hideError();
    void flushSync();
  });

  function buildCurrentPhoto(o: THREE.Group): SyncedPhoto {
    const pose = overlays.extractPose(o, null);
    return {
      aspect: pose.aspect,
      photo_az: pose.photoAz,
      photo_tilt: pose.photoTilt,
      photo_roll: pose.photoRoll,
      size_rad: pose.sizeRad,
      opacity: overlays.getOpacity(o),
    };
  }

  function photosEqual(a: SyncedPhoto, b: SyncedPhoto): boolean {
    return a.aspect === b.aspect && a.photo_az === b.photo_az && a.photo_tilt === b.photo_tilt
      && a.photo_roll === b.photo_roll && a.size_rad === b.size_rad && a.opacity === b.opacity;
  }
  function mapMeasurementsEqual(a: SyncedMapMeasurement, b: SyncedMapMeasurement): boolean {
    return a.lat === b.lat && a.lng === b.lng && a.control_point_id === b.control_point_id;
  }
  function imageMeasurementsEqual(a: SyncedImageMeasurement, b: SyncedImageMeasurement): boolean {
    return a.u === b.u && a.v === b.v && a.control_point_id === b.control_point_id;
  }
  function controlPointsEqual(a: SyncedControlPoint, b: SyncedControlPoint): boolean {
    return a.description === b.description
      && a.est_lat === b.est_lat && a.est_lng === b.est_lng && a.est_alt === b.est_alt
      && a.started_at === b.started_at && a.ended_at === b.ended_at;
  }

  function syncResource<T>(
    current: Map<string, T>,
    cached: Map<string, T>,
    equal: (a: T, b: T) => boolean,
    onCreate: ((id: string, val: T) => Promise<unknown>) | null,
    onUpdate: (id: string, val: T) => Promise<unknown>,
    onDelete: (id: string) => Promise<unknown>,
    tasks: Promise<unknown>[],
  ): void {
    for (const [id, val] of current) {
      const last = cached.get(id);
      if (!last) {
        if (onCreate) tasks.push(onCreate(id, val).then(() => { cached.set(id, val); }));
      } else if (!equal(val, last)) {
        tasks.push(onUpdate(id, val).then(() => { cached.set(id, val); }));
      }
    }
    for (const id of cached.keys()) {
      if (!current.has(id)) {
        tasks.push(onDelete(id).then(() => { cached.delete(id); }));
      }
    }
  }

  async function flushOnce(): Promise<void> {
    const locId = getCurrentStationId();
    if (!locId) return;
    const tasks: Promise<unknown>[] = [];

    const camLoc = getCameraLocation();
    if (camLoc && (synced.location?.lat !== camLoc.lat || synced.location.lng !== camLoc.lng)) {
      const nextLoc = { lat: camLoc.lat, lng: camLoc.lng };
      tasks.push(api.updateStation(locId, camLoc).then(() => { synced.location = nextLoc; }));
    }

    const currentPhotos = new Map<string, SyncedPhoto>();
    for (const o of overlays.listOverlays() as THREE.Group[]) {
      currentPhotos.set(overlayData(o).id, buildCurrentPhoto(o));
    }
    const currentMapMeasurements = new Map<string, SyncedMapMeasurement>();
    for (const m of overlays.getMapMeasurements()) {
      currentMapMeasurements.set(m.id, { lat: m.latlng.lat, lng: m.latlng.lng, control_point_id: m.controlPointId });
    }
    const currentImageMeasurements = new Map<string, SyncedImageMeasurement>();
    for (const p of overlays.getImageMeasurements()) {
      currentImageMeasurements.set(p.id, { u: p.uv.u, v: p.uv.v, control_point_id: p.controlPointId });
    }
    const currentControlPoints = new Map<string, SyncedControlPoint>();
    for (const cp of overlays.getControlPoints()) {
      // Carry started_at / ended_at through unchanged: sync doesn't track them.
      const cached = synced.controlPoints.get(cp.id);
      currentControlPoints.set(cp.id, {
        description: cp.description,
        est_lat: cp.estLat, est_lng: cp.estLng, est_alt: cp.estAlt,
        started_at: cached?.started_at ?? null,
        ended_at: cached?.ended_at ?? null,
      });
    }

    syncResource(currentPhotos, synced.photos, photosEqual,
      (_id, val) => api.createPhoto(locId, val),
      (id, val) => api.updatePhoto(id, val),
      api.deletePhoto, tasks);
    syncResource(currentMapMeasurements, synced.mapMeasurements, mapMeasurementsEqual,
      (_id, val) => api.createMapMeasurement(locId, val),
      (id, val) => api.updateMapMeasurement(id, val),
      api.deleteMapMeasurement, tasks);
    // Image measurements + control points are created via explicit handlers.
    syncResource(currentImageMeasurements, synced.imageMeasurements, imageMeasurementsEqual,
      null,
      (id, val) => api.updateImageMeasurement(id, val),
      api.deleteImageMeasurement, tasks);
    syncResource(currentControlPoints, synced.controlPoints, controlPointsEqual,
      null,
      (id, val) => api.updateControlPoint(id, val),
      api.deleteControlPoint, tasks);

    if (tasks.length > 0) await Promise.all(tasks);
  }

  async function flushSync(): Promise<void> {
    if (flushing) { flushPending = true; return; }
    flushing = true;
    try {
      flushPending = true;
      while (flushPending) {
        flushPending = false;
        try {
          await flushOnce();
        } catch (err) {
          console.error('sync failed:', err);
          showError('Some changes could not be saved.');
          return;
        }
      }
      hideError();
    } finally {
      flushing = false;
    }
  }

  return {
    registerLocation(loc) { synced.location = { lat: loc.lat, lng: loc.lng }; },
    registerPhoto(id, pose) { synced.photos.set(id, pose); },
    registerMapMeasurement(id, payload) { synced.mapMeasurements.set(id, payload); },
    registerImageMeasurement(id, payload) { synced.imageMeasurements.set(id, payload); },
    registerControlPoint(id, payload) { synced.controlPoints.set(id, payload); },
    flush() {
      if (!loaded) return;
      void flushSync();
    },
    markLoaded() { loaded = true; },
    reportError(label, err) {
      console.error(`${label}:`, err);
      showError(`Could not ${label}.`);
    },
  };
}
