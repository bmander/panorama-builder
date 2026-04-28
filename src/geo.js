// Tiny geo helpers shared by map.js (display + interaction) and solver.js (pose math).
// Flat-earth approximations are accurate to <1% at sub-km distances; great-circle for
// bearing because we want to handle anchors anywhere on Earth, not just near apex.

export const R_EARTH = 6371000;

export function bearingFromLocation(loc, latlng) {
  const φ1 = loc.lat * Math.PI / 180, φ2 = latlng.lat * Math.PI / 180;
  const Δλ = (latlng.lng - loc.lng) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x) * 180 / Math.PI;
}

// Great-circle distance between two lat/lng points, in meters.
export function groundDistance(a, b) {
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const dφ = φ2 - φ1;
  const dλ = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

// Viewer-azimuth (CCW from −Z) ↔ compass bearing (CW from N) conversions.
export const viewerAzToBearing = az => -az * 180 / Math.PI;
export const bearingToViewerAz = bDeg => -bDeg * Math.PI / 180;
