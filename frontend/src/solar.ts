// Solar position from civil datetime + lat/lng. Returns azimuth in radians from
// north clockwise and altitude in radians above the horizon. Accuracy is
// roughly ±0.5° — well within "shading reference" tolerances.
//
// Algorithm: low-precision NOAA / Astronomical Almanac formulas. The mean
// elements are linear in days-since-J2000 with small periodic corrections;
// good enough for terrain shading and ~century-range datetimes.

import { clamp, degToRad, wrap2Pi } from './mathx.js';

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

export interface SunDateTimeCandidate {
  readonly date: Date;
  readonly residualRad: number;
}

function angularDist(az1: number, alt1: number, az2: number, alt2: number): number {
  const c = Math.sin(alt1) * Math.sin(alt2) + Math.cos(alt1) * Math.cos(alt2) * Math.cos(az1 - az2);
  return Math.acos(clamp(c, -1, 1));
}

// Inverse of solarAzAlt: given a target (az, alt) at a known location and a
// year, find the moments during that year when the sun is closest to that
// target. Sweeps every day at 15-minute resolution, then refines the per-day
// best to 1 minute. Returns up to two results — the declination-conjugate
// pair that typically reproduces any given (az, alt). For any target there
// are usually two dates equidistant from the nearest solstice; near a
// solstice they collapse to a single date. Targets below the horizon
// return [].
export function findSunDateTimeCandidates(
  targetAz: number, targetAlt: number, latDeg: number, lngDeg: number, year: number,
): SunDateTimeCandidate[] {
  if (targetAlt <= 0) return [];

  const perDay: SunDateTimeCandidate[] = [];
  for (let day = 0; day < 366; day++) {
    const dayStartMs = Date.UTC(year, 0, 1) + day * 86400000;
    if (new Date(dayStartMs).getUTCFullYear() !== year) break;

    let bestMs = dayStartMs;
    let bestRes = Infinity;
    for (let m = 0; m < 24 * 60; m += 15) {
      const ms = dayStartMs + m * 60000;
      const sp = solarAzAlt(new Date(ms), latDeg, lngDeg);
      const r = angularDist(sp.az, sp.alt, targetAz, targetAlt);
      if (r < bestRes) { bestRes = r; bestMs = ms; }
    }
    for (let m = -14; m <= 14; m++) {
      const ms = bestMs + m * 60000;
      const sp = solarAzAlt(new Date(ms), latDeg, lngDeg);
      const r = angularDist(sp.az, sp.alt, targetAz, targetAlt);
      if (r < bestRes) { bestRes = r; bestMs = ms; }
    }
    perDay.push({ date: new Date(bestMs), residualRad: bestRes });
  }

  // Walk by ascending residual; require the second pick to sit at least
  // MIN_SEPARATION_DAYS away from the first so the two results land on
  // opposite sides of the nearest solstice rather than both inside the
  // same daily valley (where adjacent days have nearly identical residuals).
  const MIN_SEPARATION_DAYS = 21;
  const dayMs = 86400000;
  const ordered = [...perDay].sort((a, b) => a.residualRad - b.residualRad);
  const picked: SunDateTimeCandidate[] = [];
  for (const c of ordered) {
    const farEnough = picked.every(p => {
      const d = Math.abs(p.date.getTime() - c.date.getTime()) / dayMs;
      return Math.min(d, 365 - d) >= MIN_SEPARATION_DAYS;
    });
    if (farEnough) {
      picked.push(c);
      if (picked.length === 2) break;
    }
  }
  return picked;
}
