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

export interface OrchestrationHandlers {
  onSetLocation(loc: LatLng): void;
  onStartProjectHere(loc: LatLng): Promise<void>;
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

  async function onStartProjectHere(loc: LatLng): Promise<void> {
    let created;
    try {
      created = await api.createLocation(loc);
    } catch (err) {
      sync.reportError('start project', err);
      return;
    }
    // Hard navigate so the new project hydrates from a clean state, regardless
    // of whether we were on / or some other /<id>.
    location.assign('/' + created.id);
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
