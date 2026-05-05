// Cross-cutting types and small shared helpers.
//
// Keep this module type-only with respect to THREE. The CP detail page
// (cp.html) imports this for its DOM helpers and has no THREE importmap
// entry, so any value-level THREE reference here would break that page.

import type * as THREE from 'three';

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

// Photo pose held in the scene-graph. Mirrors the API's photo_* columns plus
// camera lat/lng (which lives on the station, not the photo, but the overlay
// renderer needs both to place the panorama).
//   photoAz:        viewer-azimuth (CCW from −Z) of overlay center
//   photoTilt:      altitude of overlay center
//   photoRoll:      in-plane rotation around the overlay's center axis,
//                   radians, CCW positive
//   sizeRad:        angular width (FOV) of the overlay
//   aspect:         photo width/height
//   camLat, camLng: panorama camera location
export interface Pose {
  readonly photoAz: number;
  readonly photoTilt: number;
  readonly photoRoll: number;
  readonly sizeRad: number;
  readonly aspect: number;
  readonly camLat: number;
  readonly camLng: number;
}

// Snapshot for the HUD readout.
export interface AzAltSnapshot {
  readonly azimuth: number;
  readonly altitude: number;
  readonly fov: number;
  readonly selectedSizeRad: number | null;
  readonly cameraHeight: number;
}

// Bearings of an overlay's left/right edges as viewer-azimuths.
export interface Cone {
  readonly azL: number;
  readonly azR: number;
}

// Per-image-measurement viewer bearing, paired with its scene-graph handle so
// the map view can correlate clicks back to the measurement it represents.
export interface ImageMeasurementBearing {
  // Server-assigned id; matches the row in the API's image_measurements table.
  readonly id: string;
  readonly handle: THREE.Mesh;
  readonly az: number;
  readonly uv: { readonly u: number; readonly v: number };
  // FK to the linked control point. Sync layer reads this when PUTing
  // image_measurements rows. Null = unlinked. Consumers that need the CP's
  // estimated lat/lng dereference via overlays.getControlPointById().
  readonly controlPointId: string | null;
  readonly selected: boolean;
}

// Control point: a real-world landmark with a latent location, observed by
// image measurements across photos / stations.
export interface ControlPointView {
  readonly id: string;
  readonly description: string;
  readonly estLat: number | null;
  readonly estLng: number | null;
  readonly estAlt: number;
  readonly selected: boolean;
}

// Bake (pixel buffer + dimensions) returned by the equirect baker.
export interface Baked {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

// userData payloads attached to scene-graph objects in overlay.ts.
// Mutable on purpose: these are the live scene-graph state we mutate in place.
export interface OverlayUserData {
  // Stable identifier across page reloads — used to correlate the overlay
  // with its persisted blob in IndexedDB. Generated at creation time.
  id: string;
  sizeRad: number;
  aspect: number;
  // In-plane roll around the overlay's center axis (radians, CCW positive).
  // 0 means the photo's local +Y is in the world's vertical plane through the
  // overlay center.
  photoRoll: number;
  // Solver locks. Mirror lock_photo_* / lock_size_rad on the API.
  lockPhotoAz: boolean;
  lockPhotoTilt: boolean;
  lockPhotoRoll: boolean;
  lockSizeRad: boolean;
  body: THREE.Mesh;
  outline?: THREE.LineSegments;
  // HUD-style action handles that appear at the photo's upper-right when
  // selected. Click-drag on each enters the corresponding input mode.
  dragHandle?: THREE.Mesh;
  rotateHandle?: THREE.Mesh;
  fovHandle?: THREE.Mesh;
  pois?: THREE.Mesh[];
}

// Per-pose-parameter solver locks for a photo. Maps 1:1 to the API's
// PhotoPosePatch lock_* fields.
export interface PhotoLocks {
  readonly lockPhotoAz: boolean;
  readonly lockPhotoTilt: boolean;
  readonly lockPhotoRoll: boolean;
  readonly lockSizeRad: boolean;
}

export interface POIUserData {
  // Server-assigned id; same as the row in the API's image_measurements table.
  id: string;
  role: 'poi';
  uv: { u: number; v: number };
  parentOverlay: THREE.Group;
  // FK to the linked control point. Null = unlinked. Render-time consumers
  // that want the CP's estimated lat/lng look it up directly via
  // overlays.getControlPointById(controlPointId).
  controlPointId: string | null;
}

// Roles tagged on every interactive scene-graph object so input.ts can
// dispatch by what the raycaster hit. handle-drag / handle-rotate / handle-fov
// are per-photo HUD widgets that appear only on the selected photo.
export type Role = 'body' | 'outline' | 'poi'
                 | 'handle-drag' | 'handle-rotate' | 'handle-fov';

export interface RoleUserData {
  role: Role;
}

// Removes `readonly` from every field of T. Use this for a local mutable
// working copy of an otherwise-readonly value type (e.g., the solver's
// in-place-updated pose).
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// --- Shared scene-graph accessors ---
// THREE.Object3D.userData is `any`, so consumers must cast. These helpers
// centralize the cast so call sites stay terse.

export const overlayData = (o: THREE.Group): OverlayUserData =>
  o.userData as OverlayUserData;

export const poiData = (poi: THREE.Mesh): POIUserData =>
  poi.userData as POIUserData;

// Every Mesh / LineSegments in this codebase is constructed with a single
// MeshBasicMaterial / LineBasicMaterial, so this narrowing is safe.
export const meshMat = (m: THREE.Mesh): THREE.MeshBasicMaterial =>
  m.material as THREE.MeshBasicMaterial;

export const lineMat = (l: THREE.LineSegments): THREE.LineBasicMaterial =>
  l.material as THREE.LineBasicMaterial;

// Read the role tag off any Object3D (returns undefined for un-tagged objects).
export const getRole = (o: THREE.Object3D): Role | undefined =>
  (o.userData as Partial<RoleUserData>).role;

// --- DOM ---

// Look up an element by id; throw with a clear message if it's missing.
// Replaces the `document.getElementById('id')!` pattern with a single
// failure mode that names the missing id. The generic is for the
// caller's convenience (e.g. `getElement<HTMLInputElement>('haze-slider')`)
// rather than narrowing — the function just casts.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export const getElement = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el as T;
};

// Wall-clock string in the form `<input type="datetime-local">` accepts:
// 'YYYY-MM-DDTHH:mm', no zone suffix.
const pad2 = (n: number): string => String(n).padStart(2, '0');
export function formatLocalDateTime(d: Date): string {
  return `${d.getFullYear().toString()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export const cpHref = (id: string): string => `/cp/${id}`;

// Shared display for a control point's est_lat/est_lng. Null on either axis
// renders as the literal "no location" so callers can disambiguate from the
// "(0, 0)" coast-of-Africa coincidence.
export function fmtCpLatLng(lat: number | null, lng: number | null): string {
  if (lat === null || lng === null) return 'no location';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

// Display label for a CP — the description, or "(unnamed)" if blank.
export const cpLabel = (description: string): string => description || '(unnamed)';

// Optional `focusImageId` deep-links the station page to recenter the 360°
// camera on a specific image measurement after hydrate.
export function stationHref(stationId: string, focusImageId?: string): string {
  const base = `/station/${stationId}`;
  return focusImageId ? `${base}?focus=${focusImageId}` : base;
}
export const FOCUS_QUERY_PARAM = 'focus';

// Index map deep-link: pan/zoom and open the popup for a specific control point.
export const indexCpHref = (cpId: string): string => `/?cp=${cpId}`;
export const INDEX_CP_QUERY_PARAM = 'cp';

// Index map deep-link: pan/zoom and open the popup for a specific station.
export const indexStationHref = (stationId: string): string => `/?station=${stationId}`;
export const INDEX_STATION_QUERY_PARAM = 'station';
