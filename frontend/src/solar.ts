// Solar position from civil datetime + lat/lng. Returns azimuth in radians from
// north clockwise and altitude in radians above the horizon. Accuracy is
// roughly ±0.5° — well within "shading reference" tolerances.
//
// Algorithm: low-precision NOAA / Astronomical Almanac formulas. The mean
// elements are linear in days-since-J2000 with small periodic corrections;
// good enough for terrain shading and ~century-range datetimes.

import { degToRad, wrap2Pi } from './mathx.js';

// J2000.0 epoch is 2000-01-01 12:00 UTC = JD 2451545.0. Unix epoch is JD
// 2440587.5, so the offset is exactly 10957.5 days.
const J2000_UNIX_DAYS = 10957.5;

export interface SunPosition {
  readonly az: number;
  readonly alt: number;
}

export function solarAzAlt(date: Date, latDeg: number, lngDeg: number): SunPosition {
  const lat = degToRad(latDeg);
  const lng = degToRad(lngDeg);
  const days = date.getTime() / 86400000 - J2000_UNIX_DAYS;

  const meanLong = degToRad(280.460 + 0.9856474 * days);
  const meanAnom = degToRad(357.528 + 0.9856003 * days);
  const eclLong = meanLong + degToRad(1.915 * Math.sin(meanAnom) + 0.020 * Math.sin(2 * meanAnom));
  const oblique = degToRad(23.439 - 0.0000004 * days);

  const ra = Math.atan2(Math.cos(oblique) * Math.sin(eclLong), Math.cos(eclLong));
  const dec = Math.asin(Math.sin(oblique) * Math.sin(eclLong));

  // Greenwich mean sidereal time, converted to radians via 15°/hour.
  const gmst = degToRad((18.697374558 + 24.06570982441908 * days) * 15);
  const ha = gmst + lng - ra;

  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  const cosHa = Math.cos(ha), sinHa = Math.sin(ha);

  const alt = Math.asin(sinLat * sinDec + cosLat * cosDec * cosHa);
  const azRaw = Math.atan2(-sinHa * cosDec, cosLat * sinDec - sinLat * cosDec * cosHa);
  const az = wrap2Pi(azRaw);

  return { az, alt };
}

// Convert solar az/alt into a Three.js direction vector pointing TOWARD the
// sun (suitable as a DirectionalLight position when target is at origin).
// Viewer convention: +X east, +Y up, -Z north.
export function sunDirection(az: number, alt: number): { x: number; y: number; z: number } {
  const cosAlt = Math.cos(alt);
  return {
    x: Math.sin(az) * cosAlt,
    y: Math.sin(alt),
    z: -Math.cos(az) * cosAlt,
  };
}
