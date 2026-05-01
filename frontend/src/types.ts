// Cross-cutting types and small shared helpers.

import type * as THREE from 'three';

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

// Photo pose, both as solver input and output.
//   photoAz:        viewer-azimuth (CCW from −Z) of overlay center
//   photoTilt:      altitude of overlay center (input only; never modified)
//   photoRoll:      in-plane rotation around the overlay's center axis,
//                   radians, CCW positive (input only; never modified —
//                   not observable from azimuth-only POI residuals)
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

// One anchored POI as seen by the solver.
export interface POIProjection {
  readonly u: number;
  readonly v: number;
  readonly anchorLat: number;
  readonly anchorLng: number;
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

// Map measurement: a user-asserted ground-truth observation on the map. A
// measurement may be linked to a control point (the latent landmark it
// observes); the column in the 360° viewer is drawn at the linked CP's
// estimated location, not the measurement's own lat/lng.
export interface MapMeasurementView {
  readonly id: string;
  readonly latlng: LatLng;
  readonly controlPointId: string | null;
  readonly selected: boolean;
}

// Control point: a real-world landmark with a latent location. May be
// referenced by image and map measurements across photos / projects.
export interface ControlPointView {
  readonly id: string;
  readonly description: string;
  readonly estLat: number | null;
  readonly estLng: number | null;
  readonly estAlt: number | null;
  readonly selected: boolean;
}

// Pose-solver inputs and outputs. The solver works on ALL anchored photos
// jointly — camera location is a shared parameter, per-photo orientation
// (photoAz, sizeRad) is local. This is necessary so POIs from every photo
// contribute evidence to the camera estimate.
export interface JointPhoto {
  readonly pose: Pose;
  readonly pois: readonly POIProjection[];
  readonly free: readonly LocalParam[];
}

export interface JointSolveResult {
  readonly camLoc: LatLng;
  readonly photos: readonly { readonly pose: Pose }[];
  readonly residualRMS: number;
  readonly iterations: number;
  readonly cameraMoved: boolean;
}

// Per-photo free parameters. Camera params are global (see solveCamera flag).
export type LocalParam = 'photoAz' | 'sizeRad' | 'photoRoll';

// Names of every parameter the solver can adjust — used by main.ts's lock
// state. Includes the global camera params alongside the per-photo locals.
export type SolverParam = LocalParam | 'camLat' | 'camLng';

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
  body: THREE.Mesh;
  outline?: THREE.LineSegments;
  handles?: THREE.Mesh[];
  pois?: THREE.Mesh[];
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
// dispatch by what the raycaster hit.
export type Role = 'body' | 'handle' | 'outline' | 'poi';

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
