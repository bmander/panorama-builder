// Async creation handlers — POST first, then mutate the scene with the
// server-assigned id. Pre-registers each new entity with the sync manager so
// the next diff sees a no-op for the freshly-created row. All handlers route
// failures through sync.reportError() so transient API problems show up in
// the user-facing banner instead of disappearing into a dropped promise.

import * as THREE from 'three';
import * as api from './api.js';
import { DEFAULT_SIZE_RAD } from './overlay.js';
import { overlayData, poiData } from './types.js';
import type { LatLng } from './types.js';
import type { OverlayManager } from './overlay.js';
import type { SyncManager } from './sync.js';
import { mergePrefs } from './prefs.js';

export interface StartProjectInput {
  readonly loc: LatLng;
  readonly name: string;
  readonly dateEstimate: string;
  readonly photos: readonly File[];
}

export interface OrchestrationHandlers {
  onSetLocation(loc: LatLng): void;
  onStartProjectHere(input: StartProjectInput): Promise<void>;
  onPhotoDropped(tex: THREE.Texture, blob: Blob, aspect: number, dir: THREE.Vector3, revokeUrl: () => void): Promise<void>;
  // Unmatched + POI armed click — always creates a new image measurement
  // (no control-point link).
  onAddImageMeasurement(overlay: THREE.Group, u: number, v: number): Promise<void>;
  // Matched click (column hover → photo click). Moves the existing pin if
  // this overlay already has one linked to controlPointId; otherwise creates.
  onMatchImageMeasurement(
    overlay: THREE.Group, u: number, v: number, controlPointId: string, latlng: LatLng,
  ): Promise<void>;
  // Map "+ POI" armed click. v1 creates a CP and a map measurement linked to
  // it; the CP carries the est_lat/est_lng (mirroring the measurement).
  onAddMapMeasurement(latlng: LatLng): Promise<void>;
  // Bearing-ray click on the map (or column drag) for an image measurement.
  // If the measurement is already linked to a CP, moves the linked map
  // measurement (and the CP estimate). If not, creates a new CP + map
  // measurement at the click latlng and links the image measurement.
  onAnchorImageMeasurementByMapClick(handle: THREE.Mesh, latlng: LatLng): Promise<void>;
}

export interface CreateOrchestrationOptions {
  getCurrentLocationId: () => string | null;
  overlays: OverlayManager;
  sync: SyncManager;
  applyCameraLocation: (loc: LatLng) => void;
  runSolve: () => void;
}

export function createOrchestration({
  getCurrentLocationId, overlays, sync, applyCameraLocation, runSolve,
}: CreateOrchestrationOptions): OrchestrationHandlers {
  function onSetLocation(loc: LatLng): void {
    if (!getCurrentLocationId()) return;
    applyCameraLocation(loc);
    runSolve();
  }

  async function onStartProjectHere(input: StartProjectInput): Promise<void> {
    const { loc, name, dateEstimate, photos } = input;
    let created;
    try {
      created = await api.createLocation(loc, name || undefined);
    } catch (err) {
      sync.reportError('start project', err);
      return;
    }
    if (dateEstimate) mergePrefs(created.id, { sunDateTime: dateEstimate });

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
      alert(`Some photos couldn't be uploaded: ${failed.join(', ')}.\nThe project was created without them.`);
    }

    location.assign('/' + created.id);
  }

  async function readAspectRatio(file: File): Promise<number> {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => { resolve(); };
        img.onerror = () => { reject(new Error('decode failed')); };
        img.src = url;
      });
      return img.naturalWidth / img.naturalHeight;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function onPhotoDropped(
    tex: THREE.Texture, blob: Blob, aspect: number, dir: THREE.Vector3, revokeUrl: () => void,
  ): Promise<void> {
    const locId = getCurrentLocationId();
    if (!locId) {
      revokeUrl();
      alert('Set a camera location before dropping photos.');
      return;
    }
    const az = Math.atan2(-dir.x, -dir.z);
    const alt = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const pose = { aspect, photo_az: az, photo_tilt: alt, photo_roll: 0, size_rad: DEFAULT_SIZE_RAD, opacity: 1 };

    let photo;
    try {
      photo = await api.createPhoto(locId, pose);
    } catch (err) {
      revokeUrl();
      sync.reportError('add photo', err);
      return;
    }
    try {
      await api.uploadPhotoBlob(photo.id, blob);
    } catch (err) {
      revokeUrl();
      await api.deletePhoto(photo.id).catch((e: unknown) => { console.error('orphan photo cleanup failed:', e); });
      sync.reportError('upload photo', err);
      return;
    }
    sync.registerPhoto(photo.id, pose);
    overlays.addOverlay(tex, aspect, dir, { id: photo.id });
    revokeUrl();
  }

  async function createImageMeasurement(
    overlay: THREE.Group, u: number, v: number,
    controlPointId: string | null, latlng: LatLng | null,
  ): Promise<THREE.Mesh | null> {
    const photoId = overlayData(overlay).id;
    let created;
    try {
      created = await api.createImageMeasurement(photoId, { u, v, control_point_id: controlPointId });
    } catch (err) {
      sync.reportError('add measurement', err);
      return null;
    }
    sync.registerImageMeasurement(created.id, { u, v, control_point_id: controlPointId });
    overlays.addImageMeasurement(overlay, u, v, {
      id: created.id, controlPointId, controlPointAnchor: latlng,
    });
    return overlays.getImageMeasurementById(created.id);
  }

  async function onAddImageMeasurement(overlay: THREE.Group, u: number, v: number): Promise<void> {
    await createImageMeasurement(overlay, u, v, null, null);
  }

  // Register a fetched CP both with sync (snake-case) and the overlay
  // manager (camelCase) — same payload, different naming conventions.
  function pushControlPoint(cp: api.ApiControlPoint): void {
    sync.registerControlPoint(cp.id, {
      description: cp.description, est_lat: cp.est_lat, est_lng: cp.est_lng, est_alt: cp.est_alt,
    });
    overlays.addControlPoint(cp.id, {
      description: cp.description, estLat: cp.est_lat, estLng: cp.est_lng, estAlt: cp.est_alt,
    });
  }

  // POST a fresh CP at latlng, register it. Returns null on API failure (the
  // banner has already been surfaced via reportError).
  async function createControlPointAt(latlng: LatLng): Promise<api.ApiControlPoint | null> {
    try {
      const cp = await api.createControlPoint({
        description: '', est_lat: latlng.lat, est_lng: latlng.lng,
      });
      pushControlPoint(cp);
      return cp;
    } catch (err) {
      sync.reportError('add control point', err);
      return null;
    }
  }

  // POST a map measurement linked to controlPointId at latlng, register it.
  // On API failure surfaces the banner and returns null; caller can treat
  // the CP as orphaned and roll it back if appropriate.
  async function createLinkedMapMeasurement(
    locId: string, latlng: LatLng, controlPointId: string,
  ): Promise<{ id: string } | null> {
    try {
      const mm = await api.createMapMeasurement(locId, {
        lat: latlng.lat, lng: latlng.lng, control_point_id: controlPointId,
      });
      sync.registerMapMeasurement(mm.id, {
        lat: latlng.lat, lng: latlng.lng, control_point_id: controlPointId,
      });
      overlays.addMapMeasurement(mm.id, latlng, controlPointId);
      return { id: mm.id };
    } catch (err) {
      sync.reportError('add map measurement', err);
      return null;
    }
  }

  async function onMatchImageMeasurement(
    overlay: THREE.Group, u: number, v: number, controlPointId: string, latlng: LatLng,
  ): Promise<void> {
    // Re-match: move the existing pin instead of stacking a duplicate.
    const existing = overlays.getImageMeasurementOnOverlayByControlPointId(overlay, controlPointId);
    if (existing) {
      overlays.moveImageMeasurement(existing, u, v);
      // Surfaces the linked map measurement if any (the FK ↔ FK link via CP).
      overlays.setSelectedPair(existing, findMapMeasurementByControlPointId(controlPointId));
      return;
    }
    const created = await createImageMeasurement(overlay, u, v, controlPointId, latlng);
    if (created) overlays.setSelectedPair(created, findMapMeasurementByControlPointId(controlPointId));
  }

  async function onAddMapMeasurement(latlng: LatLng): Promise<void> {
    const locId = getCurrentLocationId();
    if (!locId) return;
    // Create the CP first; the map measurement attaches to it. v1 mirrors
    // the measurement's lat/lng into the CP's est_*.
    const cp = await createControlPointAt(latlng);
    if (!cp) return;
    const mm = await createLinkedMapMeasurement(locId, latlng, cp.id);
    if (!mm) {
      // Roll back the CP — would otherwise be an orphan.
      await api.deleteControlPoint(cp.id).catch((e: unknown) => { console.error('orphan CP cleanup failed:', e); });
      overlays.removeControlPoint(cp.id);
    }
  }

  async function onAnchorImageMeasurementByMapClick(handle: THREE.Mesh, latlng: LatLng): Promise<void> {
    const locId = getCurrentLocationId();
    if (!locId) return;
    const pd = poiData(handle);
    // Already linked: find the linked map measurement (if any) and move it.
    // The setMapMeasurementLatLng path mirrors the new lat/lng onto the CP's
    // estimate, so the column / ray / anchor cache all follow.
    if (pd.controlPointId) {
      const linkedMM = findMapMeasurementByControlPointId(pd.controlPointId);
      if (linkedMM) {
        overlays.withBatch(() => { overlays.setMapMeasurementLatLng(linkedMM, latlng); });
        return;
      }
      // Linked to a CP that has no map measurement (e.g., the user pressed
      // anchor-by-map on an image-only CP). Create a fresh map measurement
      // and update the CP's estimate.
      const mm = await createLinkedMapMeasurement(locId, latlng, pd.controlPointId);
      if (!mm) return;
      // Mirror to CP estimate (would otherwise stay null until next setLatLng).
      overlays.setControlPointEst(pd.controlPointId, latlng);
      return;
    }
    // Unlinked: create a fresh CP + map measurement, link the image measurement.
    const cp = await createControlPointAt(latlng);
    if (!cp) return;
    const mm = await createLinkedMapMeasurement(locId, latlng, cp.id);
    if (!mm) {
      await api.deleteControlPoint(cp.id).catch((e: unknown) => { console.error('orphan CP cleanup failed:', e); });
      overlays.removeControlPoint(cp.id);
      return;
    }
    overlays.setMeasurementCP(handle, latlng, cp.id);
  }

  function findMapMeasurementByControlPointId(controlPointId: string): string | null {
    for (const mm of overlays.getMapMeasurements()) {
      if (mm.controlPointId === controlPointId) return mm.id;
    }
    return null;
  }

  return {
    onSetLocation,
    onStartProjectHere,
    onPhotoDropped,
    onAddImageMeasurement,
    onMatchImageMeasurement,
    onAddMapMeasurement,
    onAnchorImageMeasurementByMapClick,
  };
}
