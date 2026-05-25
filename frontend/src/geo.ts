// Tiny geo helpers shared by map.ts (display + interaction) and solver.ts (pose math).
// latLngToCameraRelativeMeters uses WGS84 ECEF + local ENU so the
// renderer's CP-marker positions match the solver's residual model exactly;
// bearing / distance stay great-circle since they handle anchors anywhere
// on the globe, not just near apex.

import type { LatLng } from './types.js';
import { clamp, degToRad, norm3, radToDeg } from './mathx.js';

export const R_EARTH = 6371000;

// WGS84 ellipsoid. Matches backend/solver/geo.go and bridge.cc::MakeAnchor —
// without this match the renderer's lat/lng → meters disagrees with the
// solver's residual model by ~0.1° azimuth at typical CP ranges (the
// difference between flat-earth 111320 m/° and WGS84's local meridional
// radius). Visually: every observation residual line picks up the same
// rotation bias.
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

// Kept for terrain/geometry.ts, which projects its own tile grids in a
// tight per-vertex loop. The local-meridian factor differs from 111320 by
// ~0.2 % at mid-latitudes; for terrain at multi-km scales the resulting
// shift is sub-meter and stays inside the DEM tile resolution.
export const M_PER_DEG_LAT = 111320;

interface LocalFrame {
  // ECEF position of (lat, lng, 0).
  ex: number; ey: number; ez: number;
  // East + North basis vectors of the local ENU frame in ECEF coords.
  // Up is omitted — the horizontal projections below don't need it.
  eX: number; eY: number; eZ: number;
  nX: number; nY: number; nZ: number;
}

function localFrameAt(latDeg: number, lngDeg: number): LocalFrame {
  const lat = degToRad(latDeg);
  const lng = degToRad(lngDeg);
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const sLng = Math.sin(lng), cLng = Math.cos(lng);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sLat * sLat);
  return {
    ex: N * cLat * cLng,
    ey: N * cLat * sLng,
    ez: N * (1 - WGS84_E2) * sLat,
    eX: -sLng,       eY:  cLng,       eZ: 0,
    nX: -sLat * cLng, nY: -sLat * sLng, nZ: cLat,
  };
}

// Tangent-plane projection of `pt` into a camera-relative meter frame
// centered on `camLoc`: +x east, +z south, +y unused (caller pairs with
// an elevation/height of its own). Both points are evaluated at ellipsoid
// altitude 0; the horizontal projection is independent of altitude (alt
// contributes only to the Up component, which is discarded).
export function latLngToCameraRelativeMeters(pt: LatLng, camLoc: LatLng): { x: number; z: number } {
  const s = localFrameAt(camLoc.lat, camLoc.lng);
  const p = localFrameAt(pt.lat, pt.lng);
  const dx = p.ex - s.ex, dy = p.ey - s.ey, dz = p.ez - s.ez;
  const dE = dx * s.eX + dy * s.eY + dz * s.eZ;
  const dN = dx * s.nX + dy * s.nY + dz * s.nZ;
  return { x: dE, z: -dN };
}

// Inverse of latLngToCameraRelativeMeters: given a tangent-plane offset
// (x east, z south) from `ref`, return the corresponding lat/lng. Bowring's
// closed-form ECEF→LLA is millimeter-accurate at terrestrial scale, well
// inside any round-trip tolerance the callers care about (camera flying
// and click-to-latlng).
export function tangentMetersToLatLng(ref: LatLng, x: number, z: number): LatLng {
  const r = localFrameAt(ref.lat, ref.lng);
  const dE = x, dN = -z;
  const ex = r.ex + dE * r.eX + dN * r.nX;
  const ey = r.ey + dE * r.eY + dN * r.nY;
  const ez = r.ez + dE * r.eZ + dN * r.nZ;
  const p2d = Math.hypot(ex, ey);
  const theta = Math.atan2(ez * WGS84_A, p2d * WGS84_B);
  const sTh = Math.sin(theta), cTh = Math.cos(theta);
  const sTh3 = sTh * sTh * sTh, cTh3 = cTh * cTh * cTh;
  const lat = Math.atan2(
    ez + WGS84_EP2 * WGS84_B * sTh3,
    p2d - WGS84_E2 * WGS84_A * cTh3,
  );
  const lng = Math.atan2(ey, ex);
  return { lat: radToDeg(lat), lng: radToDeg(lng) };
}

export function bearingFromLocation(loc: LatLng, latlng: LatLng): number {
  const φ1 = degToRad(loc.lat), φ2 = degToRad(latlng.lat);
  const Δλ = degToRad(latlng.lng - loc.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return radToDeg(Math.atan2(y, x));
}

// Great-circle distance between two lat/lng points, in meters.
export function groundDistance(a: LatLng, b: LatLng): number {
  const φ1 = degToRad(a.lat), φ2 = degToRad(b.lat);
  const dφ = φ2 - φ1;
  const dλ = degToRad(b.lng - a.lng);
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

// Viewer-azimuth (CCW from −Z) ↔ compass bearing (CW from N) conversions.
export const viewerAzToBearing: (az: number) => number = az => -radToDeg(az);
export const bearingToViewerAz: (bDeg: number) => number = bDeg => -degToRad(bDeg);

// Direction from origin to (x, y, z) in viewer frame (CCW from −Z, +Y up)
// → { az, alt }. Zero-length input returns {0, 0}; the y/len ratio is clamped
// so float drift doesn't NaN through asin.
export function vecToAzAlt(x: number, y: number, z: number): { az: number; alt: number } {
  const len = norm3(x, y, z);
  return {
    az: Math.atan2(-x, -z),
    alt: len === 0 ? 0 : Math.asin(clamp(y / len, -1, 1)),
  };
}

// Azimuth/altitude and straight-line range (meters) from a camera at
// camLoc/camAltMSL looking toward a world point at pt/ptAltMSL. Wraps the
// tangent-plane projection + vecToAzAlt that the camera-focus and fly-to-CP
// aiming share.
export function azAltToPoint(
  camLoc: LatLng, camAltMSL: number, pt: LatLng, ptAltMSL: number,
): { az: number; alt: number; range: number } {
  const { x, z } = latLngToCameraRelativeMeters(pt, camLoc);
  const y = ptAltMSL - camAltMSL;
  return { ...vecToAzAlt(x, y, z), range: norm3(x, y, z) };
}
