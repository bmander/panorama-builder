import { bearingFromLocation, bearingToViewerAz, latLngToCameraRelativeMeters } from './geo.js';
import { projectPOI } from './solver.js';
import type { ApiControlPoint, ApiControlPointObservations } from './api.js';
import type { LatLng, Pose } from './types.js';

const MAX_ITERS = 20;
const STEP_TOL = 1e-7;
const RESIDUAL_TOL = 1e-5;
const FD_EPS = 1e-5;
const MAP_PRIOR_SIGMA_M = 30;

const wrapPI = (a: number): number =>
  ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

function solve2x2(a00: number, a01: number, a11: number, b0: number, b1: number): [number, number] | null {
  const det = a00 * a11 - a01 * a01;
  if (Math.abs(det) < 1e-12) return null;
  return [(b0 * a11 - a01 * b1) / det, (a00 * b1 - a01 * b0) / det];
}

function residualNorm(r: readonly number[]): number {
  let s = 0;
  for (const v of r) s += v * v;
  return Math.sqrt(s);
}

function averageLatLng(points: readonly LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  let lat = 0;
  let lng = 0;
  for (const p of points) { lat += p.lat; lng += p.lng; }
  return { lat: lat / points.length, lng: lng / points.length };
}

function initialGuess(
  cp: ApiControlPoint,
  obs: ApiControlPointObservations,
): LatLng | null {
  const mapAverage = averageLatLng(obs.map_measurements.map(m => ({ lat: m.lat, lng: m.lng })));
  if (mapAverage) return mapAverage;
  if (cp.est_lat !== null && cp.est_lng !== null) return { lat: cp.est_lat, lng: cp.est_lng };
  const locAverage = averageLatLng(obs.image_measurements.map(im => ({
    lat: im.station_lat,
    lng: im.station_lng,
  })));
  return locAverage;
}

function poseFromObservation(im: ApiControlPointObservations['image_measurements'][number]): Pose {
  return {
    photoAz: im.photo_az,
    photoTilt: im.photo_tilt,
    photoRoll: im.photo_roll,
    sizeRad: im.size_rad,
    aspect: im.aspect,
    camLat: im.station_lat,
    camLng: im.station_lng,
  };
}

export interface ControlPointLocationSolveResult {
  readonly latlng: LatLng;
  readonly residualRMS: number;
  readonly iterations: number;
}

export function solveControlPointLocation(
  cp: ApiControlPoint,
  obs: ApiControlPointObservations,
): ControlPointLocationSolveResult | null {
  const imageObs = obs.image_measurements.map(im => {
    const pose = poseFromObservation(im);
    return { pose, observedAz: projectPOI(pose, im.u, im.v).az };
  });
  const mapObs = obs.map_measurements.map(m => ({ lat: m.lat, lng: m.lng }));
  if (imageObs.length === 0 && mapObs.length === 0) return null;
  if (imageObs.length + 2 * mapObs.length < 2) return null;

  const start = initialGuess(cp, obs);
  if (!start) return null;
  let current: LatLng = start;

  function computeResiduals(latlng: LatLng): number[] {
    const r: number[] = [];
    for (const im of imageObs) {
      const target = bearingToViewerAz(bearingFromLocation(
        { lat: im.pose.camLat, lng: im.pose.camLng },
        latlng,
      ));
      r.push(wrapPI(im.observedAz - target));
    }
    for (const m of mapObs) {
      const { x, z } = latLngToCameraRelativeMeters(latlng, m);
      r.push(-z / MAP_PRIOR_SIGMA_M);
      r.push(x / MAP_PRIOR_SIGMA_M);
    }
    return r;
  }

  let r = computeResiduals(current);
  let prevNorm = residualNorm(r);
  let iterations = 0;
  for (; iterations < MAX_ITERS; iterations++) {
    if (prevNorm < RESIDUAL_TOL) break;

    const rpLat = computeResiduals({ lat: current.lat + FD_EPS, lng: current.lng });
    const rnLat = computeResiduals({ lat: current.lat - FD_EPS, lng: current.lng });
    const rpLng = computeResiduals({ lat: current.lat, lng: current.lng + FD_EPS });
    const rnLng = computeResiduals({ lat: current.lat, lng: current.lng - FD_EPS });

    let j00 = 0, j01 = 0, j11 = 0, b0 = 0, b1 = 0;
    for (let i = 0; i < r.length; i++) {
      const dLat = (rpLat[i]! - rnLat[i]!) / (2 * FD_EPS);
      const dLng = (rpLng[i]! - rnLng[i]!) / (2 * FD_EPS);
      j00 += dLat * dLat;
      j01 += dLat * dLng;
      j11 += dLng * dLng;
      b0 += -dLat * r[i]!;
      b1 += -dLng * r[i]!;
    }
    const delta = solve2x2(j00 + 1e-6, j01, j11 + 1e-6, b0, b1);
    if (!delta) break;

    let alpha = 1;
    let accepted = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const trial: LatLng = {
        lat: Math.max(-90, Math.min(90, current.lat + alpha * delta[0])),
        lng: Math.max(-180, Math.min(180, current.lng + alpha * delta[1])),
      };
      const rTrial = computeResiduals(trial);
      const normTrial = residualNorm(rTrial);
      if (normTrial < prevNorm) {
        current = trial;
        r = rTrial;
        prevNorm = normTrial;
        accepted = true;
        if (Math.hypot(alpha * delta[0], alpha * delta[1]) < STEP_TOL) { iterations++; break; }
        break;
      }
      alpha *= 0.5;
    }
    if (!accepted) break;
  }

  return {
    latlng: current,
    residualRMS: residualNorm(r) / Math.sqrt(Math.max(r.length, 1)),
    iterations,
  };
}
