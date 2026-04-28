// Photo-pose solver. Given a photo's current pose, anchored POIs, and a list of
// free parameters, runs Gauss-Newton with finite-difference Jacobian to minimize
// per-POI bearing residuals.
//
// Map anchors carry only lat/lng — no elevation. Each POI therefore yields ONE
// equation (azimuth match); the photo's vertical tilt and the camera's height
// are unobservable from this data and never enter the solve.
//
// Pose shape: { photoAz, photoTilt, sizeRad, aspect, camLat, camLng }
//   - photoAz:        viewer-azimuth (CCW from −Z) of overlay center — solved-for
//   - photoTilt:      altitude of overlay center — INPUT ONLY (used by projectPOI for
//                     accurate azimuth at non-zero tilt; never modified)
//   - sizeRad:        angular width (FOV) of the overlay — solved-for at N≥2
//   - aspect:         photo width/height (locked input)
//   - camLat, camLng: panorama camera location — solved-for at N≥4
//
// POI shape: { u, v, anchorLat, anchorLng }
//   - u, v ∈ [0,1] image coords; anchor is the map POI's lat/lng.

import { bearingFromLocation, bearingToViewerAz } from './geo.js';
import type { Mutable, POIProjection, Pose, SolveResult, SolverParam } from './types.js';

// The solver mutates a working copy of the pose in place. Public Pose is
// readonly; this alias is the local mutable shape.
type WorkingPose = Mutable<Pose>;

const MAX_ITERS = 20;
const STEP_TOL = 1e-7;
const RESIDUAL_TOL = 1e-5;
const FD_EPS = 1e-5;

// Box constraint to keep sizeRad away from the degenerate zero-FOV minimum.
const PARAM_BOUNDS: Partial<Record<SolverParam, [number, number]>> = {
  sizeRad: [Math.PI / 180 * 2, Math.PI * 0.95],   // 2°–171° matches overlay's SIZE_MIN/MAX
};

function applyBounds(pose: WorkingPose): void {
  for (const k of Object.keys(PARAM_BOUNDS) as SolverParam[]) {
    const bounds = PARAM_BOUNDS[k];
    if (!bounds) continue;
    const [lo, hi] = bounds;
    if (pose[k] < lo) pose[k] = lo;
    else if (pose[k] > hi) pose[k] = hi;
  }
}

export function autoFreeParams(numPois: number): SolverParam[] {
  if (numPois <= 0) return [];
  if (numPois === 1) return ['photoAz'];
  // 4 POIs is the minimum to determine camera location from bearings (3 independent
  // pairwise-bearing-difference equations vs. 3 unknowns: camLat, camLng, sizeRad).
  if (numPois < 4)  return ['photoAz', 'sizeRad'];
  return ['photoAz', 'sizeRad', 'camLat', 'camLng'];
}

// Forward model for a POI: returns the world (azimuth, elevation) that the photo's
// pose places the POI direction in. Mirrors the math in overlay.ts's lookAt+local-XY
// composition, but written in plain trig so the solver doesn't need Three.
//
// Pipeline:
//   1. Photo center direction in world: (sin(az)·cos(alt), -sin(alt), -cos(az)·cos(alt))
//      with (az=0, alt=0) ⇒ (0,0,-1) and the YXZ rotation order, matching dirFromAzAlt.
//      (Note the sign on the y component: viewer-altitude positive means the camera
//      pitches DOWN in our viewer's drag mapping, but the POI math just needs a
//      consistent convention so we match what azFromLocal in overlay.ts produces.)
//   2. Local +Y in world: rotate world up by the photo's rotation. For a flat photo
//      facing the origin, local +Y stays in the world XY-plane projection.
//   3. POI local offset: ((u-0.5)*W, (v-0.5)*H, 0) where W = 2·R·tan(sizeRad/2),
//      H = W/aspect, R = 1 (we normalize at the end so distance cancels).
//   4. POI world dir = center + (u-0.5)*W·localX + (v-0.5)*H·localY (since the photo's
//      local +Z points toward the camera, the (u,v) plane is its tangent at distance R).
//   5. Return (atan2(-x, -z), asin(y / |dir|)).
function projectPOI(pose: Pose, u: number, v: number): { az: number; el: number } {
  const { photoAz: az, photoTilt: alt, sizeRad, aspect } = pose;

  // Photo center direction (world). Matches dirFromAzAlt(az, alt) in overlay.ts.
  const ca = Math.cos(alt), sa = Math.sin(alt);
  const caz = Math.cos(az), saz = Math.sin(az);
  // dirFromAzAlt: start (0,0,-1); rotate around X by alt; rotate around Y by az.
  // After X-rotation by alt: (0, sa, -ca).
  // After Y-rotation by az:  (-ca·saz, sa, -ca·caz).
  const cx = -ca * saz;
  const cy = sa;
  const cz = -ca * caz;

  // Local +X (right of photo) and local +Y (up) in world. With lookAt(0,0,0) the photo's
  // local frame has +Z pointing toward the camera; +X is horizontal-perpendicular-to-radial.
  // Derivation matches overlay.ts's lookAt swap convention.
  // localZ = (camera origin − overlay position) normalized = -center (already unit).
  // localX = up_world × localZ, normalized, where up_world = (0,1,0).
  //   localX = (0,1,0) × (-cx, -cy, -cz) = (1·-cz − 0·-cy, 0·-cx − 0·-cz, 0·-cy − 1·-cx)
  //          = (-cz, 0, cx).
  // localY = localZ × localX
  //        = (-cx, -cy, -cz) × (-cz, 0, cx)
  //        = (-cy·cx − -cz·0, -cz·-cz − -cx·cx, -cx·0 − -cy·-cz)
  //        = (-cy·cx, cz² + cx², -cy·cz).
  // Note: when |center| in horizontal plane = sqrt(cx² + cz²) = ca (since ca·ca·(saz²+caz²)=ca²),
  // we should still normalize for clean unit basis at non-zero alt.
  const lxX = -cz, lxZ = cx;                 // localX (y component is 0)
  const lxLen = Math.hypot(lxX, lxZ) || 1;
  const localXx = lxX / lxLen, localXy = 0, localXz = lxZ / lxLen;

  const lyX = -cy * cx, lyY = cz * cz + cx * cx, lyZ = -cy * cz;
  const lyLen = Math.hypot(lyX, lyY, lyZ) || 1;
  const localYx = lyX / lyLen, localYy = lyY / lyLen, localYz = lyZ / lyLen;

  // POI offset in plane-local coords. Use unit-radius photo plane (R=1) and scale by
  // angular size; magnitude cancels in the atan2 / asin below.
  const W = 2 * Math.tan(sizeRad / 2);
  const H = W / aspect;
  const dx = (u - 0.5) * W;
  const dy = (v - 0.5) * H;

  // POI world position (relative to camera origin); plane is at distance 1 along center.
  const px = cx + dx * localXx + dy * localYx;
  const py = cy + dx * localXy + dy * localYy;
  const pz = cz + dx * localXz + dy * localYz;

  const len = Math.hypot(px, py, pz);
  return {
    az: Math.atan2(-px, -pz),
    el: Math.asin(py / len),
  };
}

function targetBearingFor(
  pose: Pose,
  anchor: { anchorLat: number; anchorLng: number },
): number {
  const camLoc = { lat: pose.camLat, lng: pose.camLng };
  return bearingToViewerAz(bearingFromLocation(camLoc, { lat: anchor.anchorLat, lng: anchor.anchorLng }));
}

const wrapPI = (a: number): number => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

function residuals(pose: Pose, pois: POIProjection[]): number[] {
  const r = new Array<number>(pois.length);
  for (let i = 0; i < pois.length; i++) {
    const poi = pois[i]!;
    const img = projectPOI(pose, poi.u, poi.v);
    r[i] = wrapPI(img.az - targetBearingFor(pose, poi));
  }
  return r;
}

function residualNorm(r: number[]): number {
  let s = 0;
  for (const v of r) s += v * v;
  return Math.sqrt(s);
}

// Solve K×K linear system A·x = b in place via Gaussian elimination. K ≤ 6 here.
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

export function solvePose(options: {
  pose: Pose;
  pois: POIProjection[];
  free: SolverParam[];
}): SolveResult {
  const { pose, pois, free } = options;
  if (pois.length === 0 || free.length === 0) {
    return { pose: { ...pose }, residualRMS: 0, iterations: 0, cameraMoved: false };
  }
  const x: WorkingPose = { ...pose };

  let r = residuals(x, pois);
  let prevNorm = residualNorm(r);

  let iters = 0;
  for (; iters < MAX_ITERS; iters++) {
    if (prevNorm < RESIDUAL_TOL) break;

    // Numerical Jacobian: J[i][k] = ∂r_i/∂x_k via central difference.
    const m = r.length, k = free.length;
    const J: number[][] = Array.from({ length: m }, () => new Array<number>(k).fill(0));
    for (let kk = 0; kk < k; kk++) {
      const name = free[kk]!;
      const orig = x[name];
      x[name] = orig + FD_EPS;
      const rp = residuals(x, pois);
      x[name] = orig - FD_EPS;
      const rn = residuals(x, pois);
      x[name] = orig;
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

    // Try the step; back off (halve) if residual norm rises. Bounds applied to trial.
    let alpha = 1;
    let accepted = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const trial: WorkingPose = { ...x };
      for (let kk = 0; kk < k; kk++) {
        const name = free[kk]!;
        trial[name] = x[name] + alpha * dx[kk]!;
      }
      applyBounds(trial);
      const rTrial = residuals(trial, pois);
      const normTrial = residualNorm(rTrial);
      if (normTrial < prevNorm) {
        for (let kk = 0; kk < k; kk++) {
          const name = free[kk]!;
          x[name] = trial[name];
        }
        r = rTrial;
        accepted = true;
        const stepSize = Math.sqrt(dx.reduce((s, v) => s + (alpha * v) ** 2, 0));
        prevNorm = normTrial;
        if (stepSize < STEP_TOL) { iters++; break; }
        break;
      }
      alpha *= 0.5;
    }
    if (!accepted) break;
  }

  return {
    pose: x,
    residualRMS: residualNorm(r) / Math.sqrt(Math.max(r.length, 1)),
    iterations: iters,
    cameraMoved: free.includes('camLat') || free.includes('camLng'),
  };
}

// Re-exported for tests / external use.
export { projectPOI, targetBearingFor };
