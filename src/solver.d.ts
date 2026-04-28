// Migration shim. Workers converting solver.js DELETE this file.
import type { POIProjection, Pose, SolveResult, SolverParam } from './types.js';

export function autoFreeParams(numPois: number): SolverParam[];

export function solvePose(options: {
  pose: Pose;
  pois: POIProjection[];
  free: SolverParam[];
}): SolveResult;

export function projectPOI(pose: Pose, u: number, v: number): { az: number; el: number };
export function targetBearingFor(
  pose: Pose,
  anchor: { anchorLat: number; anchorLng: number },
): number;
