// Migration shim. Workers converting overlay.js DELETE this file.
import type * as THREE from 'three';
import type { Cone, LatLng, POIBearing, Pose } from './types.js';

export const OVERLAY_R: number;
export const DEFAULT_SIZE_RAD: number;
export const SIZE_MIN: number;
export const SIZE_MAX: number;
export const ROLE_BODY: 'body';
export const ROLE_HANDLE: 'handle';
export const ROLE_OUTLINE: 'outline';
export const ROLE_POI: 'poi';

export function dirFromAzAlt(az: number, alt: number): THREE.Vector3;

export interface OverlayManager {
  overlaySphere: THREE.Sphere;
  addOverlay(tex: THREE.Texture, aspect: number, dir: THREE.Vector3): THREE.Group;
  getSelected(): THREE.Group | null;
  setSelected(o: THREE.Group | null): void;
  moveSelectedTo(point: THREE.Vector3): void;
  resizeSelectedTo(sizeRad: number): void;
  deleteSelected(): void;
  addPOI(o: THREE.Group, u: number, v: number): THREE.Mesh;
  setPOIMapAnchor(poi: THREE.Mesh, latlng: LatLng | null): void;
  listOverlays(): THREE.Object3D[];
  extractPose(o: THREE.Group, camLoc: LatLng | null): Pose;
  applyPose(o: THREE.Group, pose: Pose): void;
  beginBatch(): void;
  endBatch(): void;
  withBatch(fn: () => void): void;
  movePOI(poi: THREE.Mesh, u: number, v: number): void;
  deleteSelectedPOI(): void;
  getSelectedPOI(): THREE.Mesh | null;
  setSelectedPOI(poi: THREE.Mesh | null): void;
  getPOIs(): POIBearing[];
  getCones(): Cone[];
  setVisualsVisible(visible: boolean): void;
}

export function createOverlayManager(options: {
  overlaysGroup: THREE.Group;
  getAnisotropy: () => number;
  onMutate?: () => void;
}): OverlayManager;
