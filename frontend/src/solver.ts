// Joint photo-pose + control-point solver. Given many photos sharing a
// single panorama camera location, runs Gauss-Newton with finite-difference
// Jacobian to minimize:
//
//   1. Per-image-POI bearing residuals (predicted azimuth from camera + pose
//      vs. azimuth toward the linked CP's current lat/lng estimate).
//   2. Per-map-prior penalty residuals: gaussian (1/σ-scaled) pulls on each
//      CP's lat/lng toward the user's map-measurement observation.
//
// Camera location and per-photo photoAz/sizeRad are free; CP lat/lng become
// free for any CP that has a map prior (otherwise it'd be unbounded along the
// bearing ray).
//
// Pose shape (per photo): { photoAz, photoTilt, photoRoll, sizeRad, aspect, camLat, camLng }
//   - photoAz:        viewer-azimuth (CCW from −Z) of overlay center — local free
//   - photoTilt:      altitude of overlay center — INPUT ONLY (used by projectPOI for
//                     accurate azimuth at non-zero tilt; never modified)
//   - photoRoll:      in-plane rotation around the overlay's center axis — INPUT
//                     ONLY (rotates the local X/Y basis in projectPOI; not solved
//                     for since it isn't observable from azimuth-only residuals)
//   - sizeRad:        angular width (FOV) of the overlay — local free at N≥2
//   - aspect:         photo width/height (locked input)
//   - camLat, camLng: panorama camera location — GLOBAL free, shared across photos
//
// POI shape: { u, v, controlPointId } — the solver dereferences the CP's
// current working lat/lng each residual evaluation.

import { bearingFromLocation, bearingToViewerAz, latLngToCameraRelativeMeters } from './geo.js';
import type {
  ControlPointSeed,
  JointPhoto,
  JointSolveResult,
  LatLng,
  LocalParam,
  MapPrior,
  Mutable,
  Pose,
} from './types.js';

type WorkingPose = Mutable<Pose>;

const MAX_ITERS = 20;
const STEP_TOL = 1e-7;
const RESIDUAL_TOL = 1e-5;
const FD_EPS = 1e-5;

// Box constraints. sizeRad away from the degenerate zero-FOV minimum.
const SIZE_RAD_MIN = Math.PI / 180 * 2;
const SIZE_RAD_MAX = Math.PI * 0.95;

function clampSizeRad(p: WorkingPose): void {
  if (p.sizeRad < SIZE_RAD_MIN) p.sizeRad = SIZE_RAD_MIN;
  else if (p.sizeRad > SIZE_RAD_MAX) p.sizeRad = SIZE_RAD_MAX;
}

// Free-parameter slot in the joint state vector.
type Slot =
  | { kind: 'camLat' }
  | { kind: 'camLng' }
  | { kind: 'photo'; photoIndex: number; name: LocalParam }
  | { kind: 'cpLat'; cpId: string }
  | { kind: 'cpLng'; cpId: string };

// Decides which per-photo params are worth solving for given a photo's POI
// count. Camera params are decided globally by the caller (see solveCamera).
// `solveRoll` is the user-controlled "Auto-solve photo rotation" toggle —
// roll only adds a useful DOF once 3+ POIs constrain it, so we keep it off
// at lower counts even when the toggle is on.
export function autoLocalFreeParams(numPois: number, solveRoll = false): LocalParam[] {
  if (numPois <= 0) return [];
  if (numPois === 1) return ['photoAz'];
  const free: LocalParam[] = ['photoAz', 'sizeRad'];
  if (solveRoll && numPois >= 3) free.push('photoRoll');
  return free;
}

function projectPOI(pose: Pose, u: number, v: number): { az: number; el: number } {
  const { photoAz: az, photoTilt: alt, photoRoll: roll, sizeRad, aspect } = pose;

  // Photo center direction (world), matching dirFromAzAlt(az, alt) in overlay.ts:
  // start (0,0,-1); rotate around X by alt; rotate around Y by az.
  const ca = Math.cos(alt), sa = Math.sin(alt);
  const caz = Math.cos(az), saz = Math.sin(az);
  const cx = -ca * saz;
  const cy = sa;
  const cz = -ca * caz;

  // Pre-roll local +X (right) and +Y (up) of the photo plane in world coords.
  // localX = up_world × localZ; localY = localZ × localX. See overlay.ts.
  const lxX = -cz, lxZ = cx;
  const lxLen = Math.hypot(lxX, lxZ) || 1;
  const baseXx = lxX / lxLen, baseXz = lxZ / lxLen;     // baseXy = 0 by construction

  const lyX = -cy * cx, lyY = cz * cz + cx * cx, lyZ = -cy * cz;
  const lyLen = Math.hypot(lyX, lyY, lyZ) || 1;
  const baseYx = lyX / lyLen, baseYy = lyY / lyLen, baseYz = lyZ / lyLen;

  // Apply photoRoll: rotate (baseX, baseY) around localZ. Matches
  // o.rotateZ(roll) in overlay.ts so a rolled overlay's POIs project to the
  // same world rays the renderer is drawing.
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const localXx = cr * baseXx + sr * baseYx;
  const localXy =                sr * baseYy;            // baseXy = 0
  const localXz = cr * baseXz + sr * baseYz;
  const localYx = -sr * baseXx + cr * baseYx;
  const localYy =                cr * baseYy;            // baseXy = 0
  const localYz = -sr * baseXz + cr * baseYz;

  // POI offset in plane-local coords. Unit-radius photo plane (R=1); magnitude
  // cancels in the atan2 / asin below.
  const W = 2 * Math.tan(sizeRad / 2);
  const H = W / aspect;
  const dx = (u - 0.5) * W;
  const dy = (v - 0.5) * H;

  const px = cx + dx * localXx + dy * localYx;
  const py = cy + dx * localXy + dy * localYy;
  const pz = cz + dx * localXz + dy * localYz;

  const len = Math.hypot(px, py, pz);
  return {
    az: Math.atan2(-px, -pz),
    el: Math.asin(py / len),
  };
}

function targetBearing(pose: Pose, anchorLat: number, anchorLng: number): number {
  return bearingToViewerAz(bearingFromLocation(
    { lat: pose.camLat, lng: pose.camLng },
    { lat: anchorLat, lng: anchorLng },
  ));
}

const wrapPI = (a: number): number =>
  ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

function residualNorm(r: readonly number[]): number {
  let s = 0;
  for (const v of r) s += v * v;
  return Math.sqrt(s);
}

// Solve K×K linear system A·x = b via Gaussian elimination. K is small here.
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[pivot]![i]!)) pivot = r;
    if (pivot !== i) {
      const tmpRow = A[i]!; A[i] = A[pivot]!; A[pivot] = tmpRow;
      const tmpB = b[i]!; b[i] = b[pivot]!; b[pivot] = tmpB;
    }
    const Ai = A[i]!;
    if (Math.abs(Ai[i]!) < 1e-12) return null; // singular
    for (let r = i + 1; r < n; r++) {
      const Ar = A[r]!;
      const f = Ar[i]! / Ai[i]!;
      for (let c = i; c < n; c++) Ar[c] = Ar[c]! - f * Ai[c]!;
      b[r] = b[r]! - f * b[i]!;
    }
  }
  const x = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    const Ai = A[i]!;
    let s = b[i]!;
    for (let c = i + 1; c < n; c++) s -= Ai[c]! * x[c]!;
    x[i] = s / Ai[i]!;
  }
  return x;
}

function emptyResult(
  camLoc: LatLng, photos: readonly JointPhoto[], controlPoints: readonly ControlPointSeed[],
): JointSolveResult {
  return {
    camLoc,
    photos: photos.map(p => ({ pose: { ...p.pose } })),
    controlPoints: controlPoints.map(cp => ({ id: cp.id, lat: cp.lat, lng: cp.lng })),
    residualRMS: 0,
    iterations: 0,
    cameraMoved: false,
  };
}

export function solveJointPose(options: {
  readonly camLoc: LatLng;
  readonly photos: readonly JointPhoto[];
  readonly controlPoints: readonly ControlPointSeed[];
  readonly mapPriors: readonly MapPrior[];
  readonly solveCamera: boolean;
}): JointSolveResult {
  const { camLoc, photos, controlPoints, mapPriors, solveCamera } = options;

  // Build per-photo working poses, all sharing the starting camLoc.
  const work: WorkingPose[] = photos.map(p => ({
    ...p.pose,
    camLat: camLoc.lat,
    camLng: camLoc.lng,
  }));
  let camLat = camLoc.lat;
  let camLng = camLoc.lng;

  const cpWork = new Map<string, { lat: number; lng: number }>();
  for (const cp of controlPoints) cpWork.set(cp.id, { lat: cp.lat, lng: cp.lng });

  const totalImageObs = photos.reduce((s, p) => s + p.pois.length, 0);
  const sumLocalFree = photos.reduce((s, p) => s + p.free.length, 0);
  const cpFreeSlotCount = mapPriors.length * 2;
  const totalObs = totalImageObs + 2 * mapPriors.length;

  // Demote camera-solving if the count makes it underdetermined.
  let solveCameraFinal = solveCamera;
  if (solveCameraFinal) {
    const totalUnknowns = 2 + sumLocalFree + cpFreeSlotCount;
    if (totalObs < totalUnknowns + 2) solveCameraFinal = false;
  }

  // Slot layout: camLat, camLng (if free), per-photo locals in declaration
  // order, then cpLat/cpLng for each CP that has a prior.
  const slots: Slot[] = [];
  if (solveCameraFinal) slots.push({ kind: 'camLat' }, { kind: 'camLng' });
  photos.forEach((p, photoIndex) => {
    for (const name of p.free) slots.push({ kind: 'photo', photoIndex, name });
  });
  for (const prior of mapPriors) {
    slots.push({ kind: 'cpLat', cpId: prior.cpId }, { kind: 'cpLng', cpId: prior.cpId });
  }

  if (slots.length === 0 || totalObs === 0) return emptyResult(camLoc, photos, controlPoints);

  function syncCamToPhotos(): void {
    for (const p of work) { p.camLat = camLat; p.camLng = camLng; }
  }

  function applyState(state: readonly number[]): void {
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k]!;
      const v = state[k]!;
      if (slot.kind === 'camLat') camLat = v;
      else if (slot.kind === 'camLng') camLng = v;
      else if (slot.kind === 'photo') work[slot.photoIndex]![slot.name] = v;
      else if (slot.kind === 'cpLat') cpWork.get(slot.cpId)!.lat = v;
      else cpWork.get(slot.cpId)!.lng = v;
    }
    syncCamToPhotos();
    for (const p of work) clampSizeRad(p);
  }

  function readState(): number[] {
    return slots.map(slot => {
      if (slot.kind === 'camLat') return camLat;
      if (slot.kind === 'camLng') return camLng;
      if (slot.kind === 'photo') return work[slot.photoIndex]![slot.name];
      if (slot.kind === 'cpLat') return cpWork.get(slot.cpId)!.lat;
      return cpWork.get(slot.cpId)!.lng;
    });
  }

  function computeResiduals(): number[] {
    const r: number[] = [];
    for (let i = 0; i < photos.length; i++) {
      const pose = work[i]!;
      for (const poi of photos[i]!.pois) {
        const cp = cpWork.get(poi.controlPointId)!;
        const img = projectPOI(pose, poi.u, poi.v);
        r.push(wrapPI(img.az - targetBearing(pose, cp.lat, cp.lng)));
      }
    }
    for (const prior of mapPriors) {
      const cp = cpWork.get(prior.cpId)!;
      const { x, z } = latLngToCameraRelativeMeters(cp, prior);
      r.push(-z / prior.sigmaMeters);
      r.push( x / prior.sigmaMeters);
    }
    return r;
  }

  let state = readState();
  let r = computeResiduals();
  let prevNorm = residualNorm(r);

  let iters = 0;
  for (; iters < MAX_ITERS; iters++) {
    if (prevNorm < RESIDUAL_TOL) break;

    // Numerical Jacobian via central difference: J[i][k] = ∂r_i/∂x_k.
    const m = r.length, k = state.length;
    const J: number[][] = Array.from({ length: m }, () => new Array<number>(k).fill(0));
    for (let kk = 0; kk < k; kk++) {
      const orig = state[kk]!;
      state[kk] = orig + FD_EPS;
      applyState(state);
      const rp = computeResiduals();
      state[kk] = orig - FD_EPS;
      applyState(state);
      const rn = computeResiduals();
      state[kk] = orig;
      applyState(state);
      for (let i = 0; i < m; i++) J[i]![kk] = (rp[i]! - rn[i]!) / (2 * FD_EPS);
    }

    // Normal equations: (JᵀJ + λI) Δx = -Jᵀ r. Tiny LM damping for stability.
    const lambda = 1e-6;
    const JtJ: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const Jtr = new Array<number>(k).fill(0);
    for (let kk = 0; kk < k; kk++) {
      for (let jj = 0; jj < k; jj++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[i]![kk]! * J[i]![jj]!;
        JtJ[kk]![jj] = s + (kk === jj ? lambda : 0);
      }
      let s = 0;
      for (let i = 0; i < m; i++) s += J[i]![kk]! * r[i]!;
      Jtr[kk] = -s;
    }

    const dx = solveLinear(JtJ, Jtr);
    if (!dx) break;

    // Backtracking step: halve alpha if the residual norm rises.
    let alpha = 1;
    let accepted = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const trial = state.map((s, kk) => s + alpha * dx[kk]!);
      applyState(trial);
      // applyState may have clamped sizeRad — re-read the actual state.
      const realized = readState();
      const rTrial = computeResiduals();
      const normTrial = residualNorm(rTrial);
      if (normTrial < prevNorm) {
        state = realized;
        r = rTrial;
        accepted = true;
        const stepSize = Math.sqrt(dx.reduce((acc, v) => acc + (alpha * v) ** 2, 0));
        prevNorm = normTrial;
        if (stepSize < STEP_TOL) { iters++; break; }
        break;
      }
      alpha *= 0.5;
    }
    if (!accepted) {
      // Restore working state to the last accepted iterate.
      applyState(state);
      break;
    }
  }

  const cameraMoved = solveCameraFinal && (camLat !== camLoc.lat || camLng !== camLoc.lng);
  return {
    camLoc: { lat: camLat, lng: camLng },
    photos: work.map(p => ({
      pose: {
        photoAz: p.photoAz,
        photoTilt: p.photoTilt,
        photoRoll: p.photoRoll,
        sizeRad: p.sizeRad,
        aspect: p.aspect,
        camLat,
        camLng,
      },
    })),
    controlPoints: controlPoints.map(cp => {
      const w = cpWork.get(cp.id);
      return w ? { id: cp.id, lat: w.lat, lng: w.lng } : { id: cp.id, lat: cp.lat, lng: cp.lng };
    }),
    residualRMS: residualNorm(r) / Math.sqrt(Math.max(r.length, 1)),
    iterations: iters,
    cameraMoved,
  };
}

// Re-exported for tests / external use.
export { projectPOI, targetBearing };
