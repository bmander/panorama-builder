// Cross-cutting types shared by multiple modules. Workers MUST NOT modify
// this file during the migration (avoiding merge conflicts across parallel
// PRs). Add file-local types inside each module instead.

import type * as THREE from 'three';

export interface LatLng {
  lat: number;
  lng: number;
}

// Photo pose, both as solver input and output.
//   photoAz:        viewer-azimuth (CCW from −Z) of overlay center
//   photoTilt:      altitude of overlay center (input only; never modified)
//   sizeRad:        angular width (FOV) of the overlay
//   aspect:         photo width/height
//   camLat, camLng: panorama camera location
export interface Pose {
  photoAz: number;
  photoTilt: number;
  sizeRad: number;
  aspect: number;
  camLat: number;
  camLng: number;
}

// One anchored POI as seen by the solver.
export interface POIProjection {
  u: number;
  v: number;
  anchorLat: number;
  anchorLng: number;
}

// Snapshot for the HUD readout.
export interface AzAltSnapshot {
  azimuth: number;
  altitude: number;
  fov: number;
  selectedSizeRad: number | null;
}

// Bearings of an overlay's left/right edges as viewer-azimuths.
export interface Cone {
  azL: number;
  azR: number;
}

// Per-POI viewer bearing, paired with its scene-graph handle so the map view
// can correlate clicks back to the POI it represents.
export interface POIBearing {
  handle: THREE.Mesh;
  az: number;
  uv: { u: number; v: number };
  mapAnchor: LatLng | null;
}

// Pose solver result.
export interface SolveResult {
  pose: Pose;
  residualRMS: number;
  iterations: number;
  cameraMoved: boolean;
}

// Free-parameter names accepted by the solver.
export type SolverParam = 'photoAz' | 'sizeRad' | 'camLat' | 'camLng';

// Bake (pixel buffer + dimensions) returned by the equirect baker.
export interface Baked {
  pixels: Uint8Array;
  width: number;
  height: number;
}

// userData payloads attached to scene-graph objects in overlay.js.
// `THREE.Object3D.userData` is `any`, so consumers must cast.
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

// Roles tagged on every interactive scene-graph object so input.js can
// dispatch by what the raycaster hit.
export type Role = 'body' | 'handle' | 'outline' | 'poi';

export interface RoleUserData {
  role: Role;
  cornerIndex?: number;
}
