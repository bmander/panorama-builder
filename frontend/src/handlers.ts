// Async creation handlers — POST first, then mutate the scene with the
// server-assigned id. Pre-registers each new entity with the sync manager so
// the next diff sees a no-op for the freshly-created row. All handlers route
// failures through sync.reportError() so transient API problems show up in
// the user-facing banner instead of disappearing into a dropped promise.

import * as THREE from 'three';
import * as api from './api.js';
import { DEFAULT_SIZE_RAD } from './overlay.js';
import { cpLifespanFromApi, overlayData, stationHref } from './types.js';
import type { LatLng } from './types.js';
import type { OverlayManager } from './overlay.js';
import type { SyncManager } from './sync.js';
import { clamp } from './mathx.js';

export interface StartStationInput {
  readonly loc: LatLng;
  readonly name: string;
  readonly capturedAt: string;
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
  // Index-map right-click → modal: a CP seeded at the click latlng with the
  // user-supplied estimated altitude (meters above mean sea level).
  onCreateCPAtLocation(latlng: LatLng, description: string): Promise<void>;
  // Replace the photo blob backing this overlay (for swapping in a higher-
  // resolution version). Existing pose and observations are preserved; if
  // the new file has a different aspect ratio, the overlay's body is
  // re-shaped and the change syncs to the backend.
  onReplacePhoto(overlay: THREE.Group, file: File): Promise<void>;
}

export interface CreateOrchestrationOptions {
  getCurrentStationId: () => string;
  overlays: OverlayManager;
  sync: SyncManager;
}

export async function readAspectRatio(file: File): Promise<number> {
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

export function createOrchestration({
  getCurrentStationId, overlays, sync,
}: CreateOrchestrationOptions): OrchestrationHandlers {
  async function onStartStationHere(input: StartStationInput): Promise<void> {
    const { loc, name, capturedAt, photos } = input;
    let created;
    try {
      created = await api.createStation(loc, capturedAt, name || undefined);
    } catch (err) {
      sync.reportError('start station', err);
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

  async function onPhotoDropped(
    tex: THREE.Texture, blob: Blob, aspect: number, dir: THREE.Vector3, revokeUrl: () => void,
  ): Promise<void> {
    const locId = getCurrentStationId();
    const az = Math.atan2(-dir.x, -dir.z);
    const alt = Math.asin(clamp(dir.y, -1, 1));
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
    // Newly created photos always start at the DB defaults (k1=k2=0, locked).
    sync.registerPhoto(photo.id, { ...pose, dist_k1: 0, dist_k2: 0 });
    overlays.photos.add(tex, aspect, dir, { id: photo.id });
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
    overlays.measurements.add(overlay, u, v, { id: created.id, controlPointId });
    return overlays.measurements.getById(created.id);
  }

  // Register a fetched CP both with sync (snake-case) and the overlay
  // manager (camelCase) — same payload, different naming conventions.
  function pushControlPoint(cp: api.ApiControlPoint): void {
    sync.registerControlPoint(cp.id, {
      description: cp.description, est_lat: cp.est_lat, est_lng: cp.est_lng, est_alt: cp.est_alt,
    });
    overlays.controlPoints.add(cp.id, {
      description: cp.description, estLat: cp.est_lat, estLng: cp.est_lng, estAlt: cp.est_alt,
      ...cpLifespanFromApi(cp),
    });
  }

  // POST a CP with the given payload, register it. Returns null on API
  // failure (the banner has already been surfaced via reportError).
  async function createControlPoint(
    payload: { description: string; est_lat: number | null; est_lng: number | null; est_alt: number | null },
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
    const cp = await createControlPoint({ description, est_lat: null, est_lng: null, est_alt: null });
    if (!cp) return;
    const measurement = await createImageMeasurement(overlay, u, v, cp.id);
    if (!measurement) {
      // Roll back the CP — would otherwise be an orphan with no observations.
      await api.deleteControlPoint(cp.id).catch((e: unknown) => { console.error('orphan CP cleanup failed:', e); });
      overlays.controlPoints.remove(cp.id);
    }
  }

  async function onMatchImageMeasurement(
    overlay: THREE.Group, u: number, v: number, controlPointId: string,
  ): Promise<void> {
    // Re-match: move the existing pin instead of stacking a duplicate.
    const existing = overlays.measurements.findOnOverlayByCpId(overlay, controlPointId);
    if (existing) {
      overlays.measurements.move(existing, u, v);
      overlays.measurements.setSelected(existing);
      return;
    }
    const created = await createImageMeasurement(overlay, u, v, controlPointId);
    if (created) overlays.measurements.setSelected(created);
  }

  async function onCreateCPAtLocation(
    latlng: LatLng, description: string,
  ): Promise<void> {
    await createControlPoint({
      description,
      est_lat: latlng.lat,
      est_lng: latlng.lng,
      est_alt: null,
    });
  }

  async function onReplacePhoto(overlay: THREE.Group, file: File): Promise<void> {
    const photoId = overlayData(overlay).id;
    let aspect: number;
    try {
      aspect = await readAspectRatio(file);
    } catch (err) {
      sync.reportError('decode replacement image', err);
      return;
    }
    try {
      await api.uploadPhotoBlob(photoId, file);
    } catch (err) {
      sync.reportError('replace photo', err);
      return;
    }
    overlays.photos.setAspect(overlay, aspect);
    // Use the local file as the texture source — avoids HTTP-cache fights
    // with the (now-replaced) /photos/<id>/blob URL and skips a round-trip.
    const blobUrl = URL.createObjectURL(file);
    const loader = new THREE.TextureLoader();
    loader.load(blobUrl, tex => {
      overlays.photos.setTexture(overlay, tex);
      URL.revokeObjectURL(blobUrl);
    }, undefined, (err: unknown) => {
      URL.revokeObjectURL(blobUrl);
      console.error('replacement texture load failed:', err);
    });
  }

  return {
    onStartStationHere,
    onPhotoDropped,
    onMatchImageMeasurement,
    onCreateCPAndObserve,
    onCreateCPAtLocation,
    onReplacePhoto,
  };
}
