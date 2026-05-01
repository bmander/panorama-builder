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
  // Unmatched + POI armed click — always creates a new image POI.
  onAddImagePOI(overlay: THREE.Group, u: number, v: number): Promise<void>;
  // Matched click (column hover → photo click). Moves the existing pin if
  // this overlay already has one anchored to mapPOIId; otherwise creates.
  onMatchImagePOI(overlay: THREE.Group, u: number, v: number, mapPOIId: string, latlng: LatLng): Promise<void>;
  onAddMapPOI(latlng: LatLng): Promise<void>;
  onAnchorImagePOIByMapClick(handle: THREE.Mesh, latlng: LatLng): Promise<void>;
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
    // applyCameraLocation triggers sync.flush(), which diffs map.getLocation()
    // against synced.location and PUTs the change.
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
    // Seed the project's view prefs with the user-provided date so the sun
    // marker / shaded terrain pick up the right lighting on first hydrate.
    if (dateEstimate) mergePrefs(created.id, { sunDateTime: dateEstimate });

    // Decode all images in parallel — aspect reads are independent, no need
    // to serialize behind the per-photo POST/PUT chain. Failed decodes
    // resolve to null and the corresponding upload is skipped.
    const aspects: (number | null)[] = await Promise.all(photos.map(file =>
      readAspectRatio(file).catch((err: unknown) => {
        console.error(`decode of ${file.name} failed:`, err);
        return null;
      })
    ));

    // Distribute around the horizon at altitude 0 (azimuth = i·2π/N) so photos
    // don't stack; user can refine in the photosphere afterwards. POST + PUT
    // for one photo must serialize (the PUT needs the POST's id), but each
    // photo's pipeline is independent — we still go sequentially to keep
    // server-side row creation in deterministic order.
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

    // Hard navigate so the new project hydrates from a clean state, regardless
    // of whether we were on / or some other /<id>.
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
    // Recover az/alt from the placement direction.
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
      // Roll back the metadata row so failed uploads don't accumulate orphans.
      await api.deletePhoto(photo.id).catch((e: unknown) => { console.error('orphan photo cleanup failed:', e); });
      sync.reportError('upload photo', err);
      return;
    }
    sync.registerPhoto(photo.id, pose);
    overlays.addOverlay(tex, aspect, dir, { id: photo.id });
    revokeUrl();
  }

  async function createImagePOI(
    overlay: THREE.Group, u: number, v: number, mapPOIId: string | null, latlng: LatLng | null,
  ): Promise<THREE.Mesh | null> {
    const photoId = overlayData(overlay).id;
    let created;
    try {
      created = await api.createImagePOI(photoId, { u, v, map_poi_id: mapPOIId });
    } catch (err) {
      sync.reportError('add POI', err);
      return null;
    }
    sync.registerImagePOI(created.id, { u, v, map_poi_id: mapPOIId });
    overlays.addPOI(overlay, u, v, { id: created.id, mapPOIId, mapAnchor: latlng });
    return overlays.getPOIById(created.id);
  }

  async function onAddImagePOI(overlay: THREE.Group, u: number, v: number): Promise<void> {
    await createImagePOI(overlay, u, v, null, null);
  }

  async function onMatchImagePOI(
    overlay: THREE.Group, u: number, v: number, mapPOIId: string, latlng: LatLng,
  ): Promise<void> {
    // Re-match: move the existing pin instead of stacking a duplicate.
    // movePOI fires notify(), so the diff path PUTs the new u/v on next flush.
    const existing = overlays.getPOIOnOverlayByMapPOIId(overlay, mapPOIId);
    if (existing) {
      overlays.movePOI(existing, u, v);
      overlays.setSelectedPair(existing, mapPOIId);
      return;
    }
    const created = await createImagePOI(overlay, u, v, mapPOIId, latlng);
    if (created) overlays.setSelectedPair(created, mapPOIId);
  }

  async function onAddMapPOI(latlng: LatLng): Promise<void> {
    const locId = getCurrentLocationId();
    if (!locId) return;
    let created;
    try {
      created = await api.createMapPOI(locId, latlng);
    } catch (err) {
      sync.reportError('add map POI', err);
      return;
    }
    sync.registerMapPOI(created.id, latlng);
    overlays.addMapPOI(created.id, latlng);
  }

  async function onAnchorImagePOIByMapClick(handle: THREE.Mesh, latlng: LatLng): Promise<void> {
    const locId = getCurrentLocationId();
    if (!locId) return;
    const pd = poiData(handle);
    // Bearing-ray click / anchor-marker drag both update the *linked* map POI.
    // If the image POI is already linked, move that map POI in place — this
    // also moves any other image POIs sharing the same map POI, which is the
    // intended behavior of the FK model: a landmark is shared.
    if (pd.mapPOIId) {
      overlays.withBatch(() => { overlays.setMapPOILatLng(pd.mapPOIId!, latlng); });
      return;
    }
    // Unlinked: create a fresh map POI at the click latlng and bind this image
    // POI to it.
    let newMapPOI;
    try {
      newMapPOI = await api.createMapPOI(locId, latlng);
    } catch (err) {
      sync.reportError('anchor POI', err);
      return;
    }
    sync.registerMapPOI(newMapPOI.id, latlng);
    overlays.addMapPOI(newMapPOI.id, latlng);
    overlays.setPOIMapAnchor(handle, latlng, newMapPOI.id);
  }

  return {
    onSetLocation,
    onStartProjectHere,
    onPhotoDropped,
    onAddImagePOI,
    onMatchImagePOI,
    onAddMapPOI,
    onAnchorImagePOIByMapClick,
  };
}
