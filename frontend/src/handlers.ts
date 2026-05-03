// Async creation handlers — POST first, then mutate the scene with the
// server-assigned id. Pre-registers each new entity with the sync manager so
// the next diff sees a no-op for the freshly-created row. All handlers route
// failures through sync.reportError() so transient API problems show up in
// the user-facing banner instead of disappearing into a dropped promise.

import * as THREE from 'three';
import * as api from './api.js';
import { DEFAULT_SIZE_RAD } from './overlay.js';
import { overlayData, stationHref } from './types.js';
import type { LatLng } from './types.js';
import type { OverlayManager } from './overlay.js';
import type { SyncManager } from './sync.js';
import { mergePrefs } from './prefs.js';

export interface StartStationInput {
  readonly loc: LatLng;
  readonly name: string;
  readonly dateEstimate: string;
  readonly photos: readonly File[];
}

export interface OrchestrationHandlers {
  onStartStationHere(input: StartStationInput): Promise<void>;
  onPhotoDropped(tex: THREE.Texture, blob: Blob, aspect: number, dir: THREE.Vector3, revokeUrl: () => void): Promise<void>;
  // Matched click (column hover → photo click). Moves the existing pin if
  // this overlay already has one linked to controlPointId; otherwise creates.
  onMatchImageMeasurement(
    overlay: THREE.Group, u: number, v: number, controlPointId: string,
  ): Promise<void>;
  // Right-click → context menu → modal "Create & observe": a CP with no
  // location estimate yet, plus an image measurement linked to it.
  onCreateCPAndObserve(
    overlay: THREE.Group, u: number, v: number, description: string,
  ): Promise<void>;
  // Index-map right-click → modal "Create & observe": a CP seeded at the
  // click latlng plus a global map measurement linked to it.
  onCreateCPAndMapObserve(latlng: LatLng, description: string): Promise<void>;
}

export interface CreateOrchestrationOptions {
  getCurrentStationId: () => string | null;
  overlays: OverlayManager;
  sync: SyncManager;
}

export function createOrchestration({
  getCurrentStationId, overlays, sync,
}: CreateOrchestrationOptions): OrchestrationHandlers {
  async function onStartStationHere(input: StartStationInput): Promise<void> {
    const { loc, name, dateEstimate, photos } = input;
    let created;
    try {
      created = await api.createStation(loc, name || undefined);
    } catch (err) {
      sync.reportError('start station', err);
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
      alert(`Some photos couldn't be uploaded: ${failed.join(', ')}.\nThe station was created without them.`);
    }

    location.assign(stationHref(created.id));
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
    const locId = getCurrentStationId();
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
    overlay: THREE.Group, u: number, v: number, controlPointId: string | null,
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
    overlays.addImageMeasurement(overlay, u, v, { id: created.id, controlPointId });
    return overlays.getImageMeasurementById(created.id);
  }

  // Register a fetched CP both with sync (snake-case) and the overlay
  // manager (camelCase) — same payload, different naming conventions.
  function pushControlPoint(cp: api.ApiControlPoint): void {
    sync.registerControlPoint(cp.id, {
      description: cp.description, est_lat: cp.est_lat, est_lng: cp.est_lng, est_alt: cp.est_alt,
      started_at: cp.started_at, ended_at: cp.ended_at,
    });
    overlays.addControlPoint(cp.id, {
      description: cp.description, estLat: cp.est_lat, estLng: cp.est_lng, estAlt: cp.est_alt,
    });
  }

  // POST a CP with the given payload, register it. Returns null on API
  // failure (the banner has already been surfaced via reportError).
  async function createControlPoint(
    payload: { description: string; est_lat: number | null; est_lng: number | null },
  ): Promise<api.ApiControlPoint | null> {
    try {
      const cp = await api.createControlPoint(payload);
      pushControlPoint(cp);
      return cp;
    } catch (err) {
      sync.reportError('add control point', err);
      return null;
    }
  }

  async function onCreateCPAndObserve(
    overlay: THREE.Group, u: number, v: number, description: string,
  ): Promise<void> {
    const cp = await createControlPoint({ description, est_lat: null, est_lng: null });
    if (!cp) return;
    const measurement = await createImageMeasurement(overlay, u, v, cp.id);
    if (!measurement) {
      // Roll back the CP — would otherwise be an orphan with no observations.
      await api.deleteControlPoint(cp.id).catch((e: unknown) => { console.error('orphan CP cleanup failed:', e); });
      overlays.removeControlPoint(cp.id);
    }
  }

  // POST a map measurement linked to controlPointId at latlng, register it.
  // On API failure surfaces the banner and returns null; caller can treat
  // the CP as orphaned and roll it back if appropriate.
  async function createLinkedMapMeasurement(
    latlng: LatLng, controlPointId: string,
  ): Promise<{ id: string } | null> {
    try {
      const mm = await api.createMapMeasurement({
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
    overlay: THREE.Group, u: number, v: number, controlPointId: string,
  ): Promise<void> {
    // Re-match: move the existing pin instead of stacking a duplicate.
    const existing = overlays.getImageMeasurementOnOverlayByControlPointId(overlay, controlPointId);
    if (existing) {
      overlays.moveImageMeasurement(existing, u, v);
      // Surfaces the linked map measurement if any (the FK ↔ FK link via CP).
      overlays.setSelectedPair(existing, findMapMeasurementByControlPointId(controlPointId));
      return;
    }
    const created = await createImageMeasurement(overlay, u, v, controlPointId);
    if (created) overlays.setSelectedPair(created, findMapMeasurementByControlPointId(controlPointId));
  }

  async function onCreateCPAndMapObserve(latlng: LatLng, description: string): Promise<void> {
    const cp = await createControlPoint({ description, est_lat: latlng.lat, est_lng: latlng.lng });
    if (!cp) return;
    const mm = await createLinkedMapMeasurement(latlng, cp.id);
    if (!mm) {
      await api.deleteControlPoint(cp.id).catch((e: unknown) => { console.error('orphan CP cleanup failed:', e); });
      overlays.removeControlPoint(cp.id);
    }
  }

  function findMapMeasurementByControlPointId(controlPointId: string): string | null {
    for (const mm of overlays.getMapMeasurements()) {
      if (mm.controlPointId === controlPointId) return mm.id;
    }
    return null;
  }

  return {
    onStartStationHere,
    onPhotoDropped,
    onMatchImageMeasurement,
    onCreateCPAndObserve,
    onCreateCPAndMapObserve,
  };
}
