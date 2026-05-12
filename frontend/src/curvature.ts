// Earth-curvature + atmospheric-refraction state shared across every
// depth-aware renderer. Single source of truth for the two settings
// checkboxes; subscribers fire only when the effective factor actually
// changes (toggling refraction while curvature is off is silent), which
// keeps the no-op-rebuild guard out of every consumer.

import { R_EARTH } from './geo.js';

// Standard surveyor's value, the "0.0675 d² km" rule of thumb.
const SURVEY_REFRACTION_K = 0.14;

export const CURVATURE_FACTOR_GEOMETRIC = 1 / (2 * R_EARTH);
export const CURVATURE_FACTOR_REFRACTED = (1 - SURVEY_REFRACTION_K) / (2 * R_EARTH);

let curvatureEnabled = true;
let refractionEnabled = true;

function computeFactor(): number {
  if (!curvatureEnabled) return 0;
  return refractionEnabled ? CURVATURE_FACTOR_REFRACTED : CURVATURE_FACTOR_GEOMETRIC;
}

let lastFactor = computeFactor();
const subscribers = new Set<() => void>();

export function getCurvatureFactor(): number {
  return computeFactor();
}

export function getCurvatureEnabled(): boolean {
  return curvatureEnabled;
}

export function getRefractionEnabled(): boolean {
  return refractionEnabled;
}

export function curvatureDrop(distSqM: number): number {
  return computeFactor() * distSqM;
}

export function setCurvatureEnabled(enabled: boolean): void {
  if (curvatureEnabled === enabled) return;
  curvatureEnabled = enabled;
  notify();
}

export function setRefractionEnabled(enabled: boolean): void {
  if (refractionEnabled === enabled) return;
  refractionEnabled = enabled;
  notify();
}

export function subscribeCurvatureChange(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function notify(): void {
  const f = computeFactor();
  if (f === lastFactor) return;
  lastFactor = f;
  for (const cb of subscribers) cb();
}
