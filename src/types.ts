// Cross-cutting types and small shared helpers.

import type * as THREE from 'three';

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

// Photo pose, both as solver input and output.
//   photoAz:        viewer-azimuth (CCW from −Z) of overlay center
//   photoTilt:      altitude of overlay center (input only; never modified)
//   sizeRad:        angular width (FOV) of the overlay
//   aspect:         photo width/height
//   camLat, camLng: panorama camera location
export interface Pose {
  readonly photoAz: number;
  readonly photoTilt: number;
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
}

// Bearings of an overlay's left/right edges as viewer-azimuths.
export interface Cone {
  readonly azL: number;
  readonly azR: number;
}

// Per-POI viewer bearing, paired with its scene-graph handle so the map view
// can correlate clicks back to the POI it represents.
export interface POIBearing {
  readonly handle: THREE.Mesh;
  readonly az: number;
  readonly uv: { readonly u: number; readonly v: number };
  readonly mapAnchor: LatLng | null;
}

// Pose solver result.
export interface SolveResult {
  readonly pose: Pose;
  readonly residualRMS: number;
  readonly iterations: number;
  readonly cameraMoved: boolean;
}

// Free-parameter names accepted by the solver.
export type SolverParam = 'photoAz' | 'sizeRad' | 'camLat' | 'camLng';

// Bake (pixel buffer + dimensions) returned by the equirect baker.
export interface Baked {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

// userData payloads attached to scene-graph objects in overlay.ts.
// Mutable on purpose: these are the live scene-graph state we mutate in place.
export interface OverlayUserData {
  sizeRad: number;
  aspect: number;
  body: THREE.Mesh;
  outline?: THREE.LineSegments;
  handles?: THREE.Mesh[];
  pois?: THREE.Mesh[];
}

export interface POIUserData {
  role: 'poi';
  uv: { u: number; v: number };
  parentOverlay: THREE.Group;
  mapAnchor: LatLng | null;
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
// failure mode that names the missing id.
export function getElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el as T;
}
