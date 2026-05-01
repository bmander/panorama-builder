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
export interface SyncedMapPOI { lat: number; lng: number; }
export interface SyncedImagePOI { u: number; v: number; map_poi_id: string | null; }

export interface SyncManager {
  registerLocation(loc: LatLng): void;
  registerPhoto(id: string, pose: SyncedPhoto): void;
  registerMapPOI(id: string, latlng: LatLng): void;
  registerImagePOI(id: string, payload: SyncedImagePOI): void;
  flush(): void;
  markLoaded(): void;
  reportError(label: string, err: unknown): void;
}

export interface CreateSyncManagerOptions {
  overlays: OverlayManager;
  getCurrentLocationId: () => string | null;
  getCameraLocation: () => LatLng | null;
}

export function createSyncManager({
  overlays, getCurrentLocationId, getCameraLocation,
}: CreateSyncManagerOptions): SyncManager {
  interface SyncedLocation { lat: number; lng: number; }
  const synced = {
    location: null as SyncedLocation | null,
    photos: new Map<string, SyncedPhoto>(),
    mapPois: new Map<string, SyncedMapPOI>(),
    imagePois: new Map<string, SyncedImagePOI>(),
  };

  // While !loaded, flush() is a no-op so initial scene reconstruction doesn't
  // look like a flood of new entities.
  let loaded = false;
  // Re-entrancy guard; at most one flushSync runs at a time.
  let flushing = false;
  let flushPending = false;

  // Error banner — looked up once at construct time.
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
    // camLoc isn't part of the per-photo sync payload — pass null to skip lookup.
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
  function mapPOIsEqual(a: SyncedMapPOI, b: SyncedMapPOI): boolean {
    return a.lat === b.lat && a.lng === b.lng;
  }
  function imagePOIsEqual(a: SyncedImagePOI, b: SyncedImagePOI): boolean {
    return a.u === b.u && a.v === b.v && a.map_poi_id === b.map_poi_id;
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
        // onCreate is null for resources whose creates always go through an
        // explicit handler (e.g., image POIs). A diff-detected new entity for
        // such a resource means a bug in the orchestration layer; skip silently.
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
    const locId = getCurrentLocationId();
    if (!locId) return;
    const tasks: Promise<unknown>[] = [];

    const camLoc = getCameraLocation();
    if (camLoc && (synced.location?.lat !== camLoc.lat || synced.location.lng !== camLoc.lng)) {
      const nextLoc = { lat: camLoc.lat, lng: camLoc.lng };
      tasks.push(api.updateLocation(locId, camLoc).then(() => { synced.location = nextLoc; }));
    }

    const currentPhotos = new Map<string, SyncedPhoto>();
    for (const o of overlays.listOverlays() as THREE.Group[]) {
      currentPhotos.set(overlayData(o).id, buildCurrentPhoto(o));
    }
    const currentMapPois = new Map<string, SyncedMapPOI>();
    for (const m of overlays.getMapPOIs()) {
      currentMapPois.set(m.id, { lat: m.latlng.lat, lng: m.latlng.lng });
    }
    const currentImagePois = new Map<string, SyncedImagePOI>();
    for (const p of overlays.getPOIs()) {
      currentImagePois.set(p.id, { u: p.uv.u, v: p.uv.v, map_poi_id: p.mapPOIId });
    }

    syncResource(currentPhotos, synced.photos, photosEqual,
      (_id, val) => api.createPhoto(locId, val),
      (id, val) => api.updatePhoto(id, val),
      api.deletePhoto, tasks);
    syncResource(currentMapPois, synced.mapPois, mapPOIsEqual,
      (_id, val) => api.createMapPOI(locId, val),
      (id, val) => api.updateMapPOI(id, val),
      api.deleteMapPOI, tasks);
    // Image POIs are always created via the explicit handler, never diff.
    syncResource(currentImagePois, synced.imagePois, imagePOIsEqual,
      null,
      (id, val) => api.updateImagePOI(id, val),
      api.deleteImagePOI, tasks);

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
          // Failed entries stay un-committed in `synced`, so the next mutation
          // (or a manual retry) re-issues them via the diff path.
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
    registerMapPOI(id, latlng) { synced.mapPois.set(id, { lat: latlng.lat, lng: latlng.lng }); },
    registerImagePOI(id, payload) { synced.imagePois.set(id, payload); },
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
