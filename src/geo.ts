// Tiny geo helpers shared by map.ts (display + interaction) and solver.ts (pose math).
// Flat-earth approximations are accurate to <1% at sub-km distances; great-circle for
// bearing because we want to handle anchors anywhere on Earth, not just near apex.

import type { LatLng } from './types.js';

export const R_EARTH = 6371000;

// Local-tangent-plane approximation: meters per degree latitude is roughly
// constant (Earth is round); per-degree longitude scales by cos(lat).
export const M_PER_DEG_LAT = 111320;

// Tangent-plane projection of `pt` into a camera-relative meter frame
// centered on `camLoc`: +x east, +z south, +y unused (caller pairs with an
// elevation/height of its own). Accurate to <1 % within ~50 km of camLoc.
export function latLngToCameraRelativeMeters(pt: LatLng, camLoc: LatLng): { x: number; z: number } {
  const cosLat = Math.cos(camLoc.lat * Math.PI / 180);
  return {
    x: (pt.lng - camLoc.lng) * M_PER_DEG_LAT * cosLat,
    z: -(pt.lat - camLoc.lat) * M_PER_DEG_LAT,
  };
}

export function bearingFromLocation(loc: LatLng, latlng: LatLng): number {
  const φ1 = loc.lat * Math.PI / 180, φ2 = latlng.lat * Math.PI / 180;
  const Δλ = (latlng.lng - loc.lng) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x) * 180 / Math.PI;
}

// Great-circle distance between two lat/lng points, in meters.
export function groundDistance(a: LatLng, b: LatLng): number {
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const dφ = φ2 - φ1;
  const dλ = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

// Viewer-azimuth (CCW from −Z) ↔ compass bearing (CW from N) conversions.
export const viewerAzToBearing: (az: number) => number = az => -az * 180 / Math.PI;
export const bearingToViewerAz: (bDeg: number) => number = bDeg => -bDeg * Math.PI / 180;
