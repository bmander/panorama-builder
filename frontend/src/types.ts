// Cross-cutting types and small shared helpers.
//
// Keep this module type-only with respect to THREE. The CP detail page
// (cp.html) imports this for its DOM helpers and has no THREE importmap
// entry, so any value-level THREE reference here would break that page.

import type * as THREE from 'three';

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

// Photo pose held in the scene-graph. Mirrors the API's photo_* columns plus
// camera lat/lng (which lives on the station, not the photo, but the overlay
// renderer needs both to place the panorama).
//   photoAz:        viewer-azimuth (CCW from −Z) of overlay center
//   photoTilt:      altitude of overlay center
//   photoRoll:      in-plane rotation around the overlay's center axis,
//                   radians, CCW positive
//   sizeRad:        angular width (FOV) of the overlay
//   aspect:         photo width/height
//   camLat, camLng: panorama camera location
export interface Pose {
  readonly photoAz: number;
  readonly photoTilt: number;
  readonly photoRoll: number;
  readonly sizeRad: number;
  readonly aspect: number;
  readonly camLat: number;
  readonly camLng: number;
  // Brown-Conrady radial distortion coefficients. 0 = pure pinhole.
  readonly k1: number;
  readonly k2: number;
}

// Snapshot for the HUD readout.
export interface AzAltSnapshot {
  readonly azimuth: number;
  readonly altitude: number;
  readonly fov: number;
  readonly selectedSizeRad: number | null;
  // Angular subtense per source-image pixel (rad). Null when no photo is
  // selected or its texture's pixel width isn't yet known.
  readonly selectedRadPerPixel: number | null;
  // Camera elevation in metres above mean sea level (the viewer's y=0).
  readonly cameraMSL: number;
  // Derived: cameraMSL minus the DEM ground elevation at the mesh build
  // location. Useful in the HUD; renderers should use cameraMSL.
  readonly cameraHeightAboveGround: number;
}

// Bearings of an overlay's left/right edges as viewer-azimuths.
export interface Cone {
  readonly azL: number;
  readonly azR: number;
}

// Per-image-measurement viewer bearing, paired with its scene-graph handle so
// the map view can correlate clicks back to the measurement it represents.
export interface ImageMeasurementBearing {
  // Server-assigned id; matches the row in the API's image_measurements table.
  readonly id: string;
  readonly handle: THREE.Mesh;
  readonly az: number;
  readonly uv: { readonly u: number; readonly v: number };
  // FK to the linked control point. Sync layer reads this when PUTing
  // image_measurements rows. Null = unlinked. Consumers that need the CP's
  // estimated lat/lng dereference via overlays.getControlPointById().
  readonly controlPointId: string | null;
  readonly selected: boolean;
}

// Lifespan bounds for a control point. Either bound being null means
// "open-ended". The *_after / *_before flags flip the matching bound to
// strict (the landmark started/ended outside that timestamp, not on it).
export interface CPLifespan {
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly startedAfter: boolean;
  readonly endedBefore: boolean;
}

// Map the API's snake_case lifespan fields to our camelCase CPLifespan.
// Structural input — avoids importing api-types into this module.
export function cpLifespanFromApi(cp: {
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly started_after: boolean;
  readonly ended_before: boolean;
}): CPLifespan {
  return {
    startedAt: cp.started_at,
    endedAt: cp.ended_at,
    startedAfter: cp.started_after,
    endedBefore: cp.ended_before,
  };
}

// True when the lifespan window contains timestamp `ms`. Both bounds null
// means "always extant".
export function isExtantAt(span: CPLifespan, ms: number): boolean {
  if (span.startedAt !== null) {
    const t = new Date(span.startedAt).getTime();
    if (span.startedAfter ? ms <= t : ms < t) return false;
  }
  if (span.endedAt !== null) {
    const t = new Date(span.endedAt).getTime();
    if (span.endedBefore ? ms >= t : ms > t) return false;
  }
  return true;
}

// Control point: a real-world landmark with a latent location, observed by
// image measurements across photos / stations.
export interface ControlPointView {
  readonly id: string;
  readonly description: string;
  readonly estLat: number | null;
  readonly estLng: number | null;
  readonly estAlt: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly startedAfter: boolean;
  readonly endedBefore: boolean;
  readonly selected: boolean;
}

// Pairwise hard equality between two control points.
//   'plumb' → cpA and cpB share est_lat AND est_lng (vertical line).
//   'level' → cpA and cpB share est_alt           (horizontal alignment).
export type CPConstraintType = 'plumb' | 'level';

// Frontend view of a CP-CP constraint. Mirrors the API row but renamed to
// the project-wide camelCase convention.
export interface CPConstraintView {
  readonly id: string;
  readonly cpAId: string;
  readonly cpBId: string;
  readonly type: CPConstraintType;
}

// Frontend view of a CP surface. `cpIds` carries 3 (triangle) or 4 (quad)
// unique control-point ids in render order (cyclic; consecutive ids form
// each edge of the polygon).
export interface CPSurfaceView {
  readonly id: string;
  readonly cpIds: readonly string[];
}

// Bake (pixel buffer + dimensions) returned by the equirect baker.
export interface Baked {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

// userData payloads attached to scene-graph objects in overlay.ts.
// Mutable on purpose: these are the live scene-graph state we mutate in place.
export interface OverlayUserData {
  // Stable identifier across page reloads — used to correlate the overlay
  // with its persisted blob in IndexedDB. Generated at creation time.
  id: string;
  sizeRad: number;
  aspect: number;
  // Canonical pose angles; cached here to avoid float drift on the
  // o.position → atan2/asin round-trip, which otherwise made every solve
  // look like a 1-photo edit and produced a phantom PUT on rehydrate.
  photoAz: number;
  photoTilt: number;
  // In-plane roll around the overlay's center axis (radians, CCW positive).
  // 0 means the photo's local +Y is in the world's vertical plane through the
  // overlay center.
  photoRoll: number;
  // Solver locks. Mirror lock_photo_* / lock_size_rad / lock_dist_k* on the API.
  lockPhotoAz: boolean;
  lockPhotoTilt: boolean;
  lockPhotoRoll: boolean;
  lockSizeRad: boolean;
  // Brown-Conrady radial distortion coefficients (zero by default; locked).
  distK1: number;
  distK2: number;
  lockDistK1: boolean;
  lockDistK2: boolean;
  body: THREE.Mesh;
  outline?: THREE.LineSegments;
  // HUD-style action handles that appear at the photo's upper-right when
  // selected. Click-drag on each enters the corresponding input mode.
  dragHandle?: THREE.Mesh;
  rotateHandle?: THREE.Mesh;
  fovHandle?: THREE.Mesh;
  pois?: THREE.Mesh[];
}

// Per-pose-parameter solver locks for a photo. Maps 1:1 to the API's
// PhotoPosePatch lock_* fields.
export interface PhotoLocks {
  readonly lockPhotoAz: boolean;
  readonly lockPhotoTilt: boolean;
  readonly lockPhotoRoll: boolean;
  readonly lockSizeRad: boolean;
  readonly lockDistK1: boolean;
  readonly lockDistK2: boolean;
}

export interface POIUserData {
  // Server-assigned id; same as the row in the API's image_measurements table.
  id: string;
  role: 'poi';
  uv: { u: number; v: number };
  parentOverlay: THREE.Group;
  // FK to the linked control point. Null = unlinked. Render-time consumers
  // that want the CP's estimated lat/lng look it up directly via
  // overlays.getControlPointById(controlPointId).
  controlPointId: string | null;
}

// Roles tagged on every interactive scene-graph object so input.ts can
// dispatch by what the raycaster hit. handle-drag / handle-rotate / handle-fov
// are per-photo HUD widgets that appear only on the selected photo.
export type Role = 'body' | 'outline' | 'poi'
                 | 'handle-drag' | 'handle-rotate' | 'handle-fov';

export interface RoleUserData {
  role: Role;
}

// Removes `readonly` from every field of T. Use this for a local mutable
// working copy of an otherwise-readonly value type (e.g., the solver's
// in-place-updated pose).
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// --- Shared scene-graph accessors ---
// THREE.Object3D.userData is `any`, so consumers must cast. These helpers
// centralize the cast so call sites stay terse.

export const overlayData = (o: THREE.Group): OverlayUserData =>
  o.userData as OverlayUserData;

export const poiData = (poi: THREE.Mesh): POIUserData =>
  poi.userData as POIUserData;

// Every Mesh / LineSegments in this codebase is constructed with a single
// MeshBasicMaterial / LineBasicMaterial, so this narrowing is safe.
export const meshMat = (m: THREE.Mesh): THREE.MeshBasicMaterial =>
  m.material as THREE.MeshBasicMaterial;

export const lineMat = (l: THREE.LineSegments): THREE.LineBasicMaterial =>
  l.material as THREE.LineBasicMaterial;

// Read the role tag off any Object3D (returns undefined for un-tagged objects).
export const getRole = (o: THREE.Object3D): Role | undefined =>
  (o.userData as Partial<RoleUserData>).role;

// --- DOM ---

// Look up an element by id; throw with a clear message if it's missing.
// Replaces the `document.getElementById('id')!` pattern with a single
// failure mode that names the missing id. The generic is for the
// caller's convenience (e.g. `getElement<HTMLInputElement>('haze-slider')`)
// rather than narrowing — the function just casts.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export const getElement = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el as T;
};

// Push a value into an input without clobbering it while the user is typing,
// and skip the DOM write when nothing changed (used on drag-rate refresh paths).
export function syncInputValue(el: HTMLInputElement, value: string): void {
  if (document.activeElement === el) return;
  if (el.value !== value) el.value = value;
}
export function syncInputChecked(el: HTMLInputElement, value: boolean): void {
  if (document.activeElement === el) return;
  if (el.checked !== value) el.checked = value;
}

// Wall-clock string in the form `<input type="datetime-local">` accepts:
// 'YYYY-MM-DDTHH:mm', no zone suffix.
const pad2 = (n: number): string => String(n).padStart(2, '0');
export function formatLocalDateTime(d: Date): string {
  return `${d.getFullYear().toString()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export const cpHref = (id: string): string => `/cp/${id}`;

// Shared display for a control point's est_lat/est_lng. Null on either axis
// renders as the literal "no location" so callers can disambiguate from the
// "(0, 0)" coast-of-Africa coincidence.
export function fmtCpLatLng(lat: number | null, lng: number | null): string {
  if (lat === null || lng === null) return 'no location';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export function fmtAlt(alt: number | null): string {
  return alt === null ? '—' : `${alt.toFixed(1)} m`;
}

// Display label for a CP — the description, or "(unnamed)" if blank.
export const cpLabel = (description: string): string => description || '(unnamed)';

// Truncate an opaque server id for compact display.
const SHORT_ID_LEN = 6;
export const shortId = (id: string): string =>
  id.length > SHORT_ID_LEN ? id.slice(0, SHORT_ID_LEN) : id;

// Format a session/commit conflict ref like "photo/abc123" for the user.
export const fmtRef = (r: { entity_type: string; entity_id: string }): string =>
  `${r.entity_type}/${shortId(r.entity_id)}`;

// Display label for a station — its name, or a short-id stub if untitled.
export const stationLabel = (id: string, name: string | null): string =>
  name ?? `(untitled ${id.slice(0, 6)})`;

// Builds one `.col` cell in a `.cp-list` row. See cp.css for the CSS hooks
// (`.val`, `.val.unlocated`, `.lock-mark`).
export function makeListCell(
  className: string, value: string, locked: boolean, unlocated = false,
): HTMLElement {
  const cell = document.createElement('span');
  cell.className = `col ${className}`;
  const val = document.createElement('span');
  val.className = 'val';
  if (unlocated) val.classList.add('unlocated');
  val.textContent = value;
  cell.append(val);
  if (locked) {
    const mark = document.createElement('span');
    mark.className = 'lock-mark';
    mark.setAttribute('aria-label', 'locked');
    cell.append(mark);
  }
  return cell;
}

// Append a "±X" σ span to `cell` (typically a .col cell produced by
// makeListCell). Caller pre-formats via fmtSigmaMeters / fmtSigmaRad and
// picks the severity class via sigmaSeverityClass. tooltip is optional.
export function appendSigma(cell: HTMLElement, text: string, severityClass: string, tooltip?: string): void {
  const s = document.createElement('span');
  s.className = `sigma ${severityClass}`;
  s.textContent = `±${text}`;
  if (tooltip) s.title = tooltip;
  cell.append(s);
}

// Format a σ value (meters) for compact display. Chooses unit by magnitude
// so cm-scale uncertainties don't render as "0.012 m" but "1.2 cm".
//   null  →  "?"   (no solve has populated this axis yet)
//   < 0.1 m  →  "X.Xcm"
//   < 1000 m →  "X.XXm"
//   else  →  "X.Xkm"
export function fmtSigmaMeters(sigma: number | null | undefined): string {
  if (sigma === null || sigma === undefined) return '?';
  const abs = Math.abs(sigma);
  if (abs < 0.1) return `${(sigma * 100).toFixed(1)}cm`;
  if (abs < 1000) return `${sigma.toFixed(2)}m`;
  return `${(sigma / 1000).toFixed(1)}km`;
}

// Format a σ value (radians) for compact display as degrees / arc-units.
//   null  →  "?"
//   < 1 arcmin (≈ 2.9e-4 rad) → "X.X″" (arcseconds)
//   < 1° → "X.X′" (arcminutes)
//   else  → "X.XX°"
export function fmtSigmaRad(sigma: number | null | undefined): string {
  if (sigma === null || sigma === undefined) return '?';
  const deg = sigma * 180 / Math.PI;
  if (deg < 1 / 60) return `${(deg * 3600).toFixed(1)}″`;
  if (deg < 1) return `${(deg * 60).toFixed(2)}′`;
  return `${deg.toFixed(2)}°`;
}

// CSS class to color a σ display by magnitude. Caller passes the σ in
// meters or radians and the same per-axis threshold pair used by the merge
// gate (defaults chosen to match backend/solve_merge_gate.go).
export function sigmaSeverityClass(
  sigma: number | null | undefined,
  warnAt: number, refuseAt: number,
): string {
  if (sigma === null || sigma === undefined) return 'sigma-unknown';
  const a = Math.abs(sigma);
  if (a >= refuseAt) return 'sigma-bad';
  if (a >= warnAt) return 'sigma-warn';
  return 'sigma-good';
}

// 13-char base32 IDs from `crypto/rand` on the backend. Shared so the two
// regex sites that validate them (URL params, popstate handler) and the
// CP-page id parser stay in sync.
export const ID_RE = /^[A-Z2-7]{13}$/;

// Optional focus deep-links the station page to recenter the 360° camera
// on a specific entity after hydrate. focusImageId and focusControlPointId
// are mutually exclusive in practice; if both are set the station page
// applies focusControlPointId.
export function stationHref(
  stationId: string,
  opts: { focusImageId?: string; focusControlPointId?: string } = {},
): string {
  const params = new URLSearchParams({ sta: stationId });
  if (opts.focusImageId) params.set(FOCUS_QUERY_PARAM, opts.focusImageId);
  if (opts.focusControlPointId) params.set(FOCUS_CP_QUERY_PARAM, opts.focusControlPointId);
  return `/world?${params.toString()}`;
}

// Reads & validates the station id from the current URL's `?sta=` param.
export function parseStaFromURL(): string | null {
  const sta = new URLSearchParams(location.search).get('sta');
  return sta && ID_RE.test(sta) ? sta : null;
}
export const FOCUS_QUERY_PARAM = 'focus';
export const FOCUS_CP_QUERY_PARAM = 'focus_cp';

// Index map deep-link: pan/zoom and open the popup for a specific control point.
export const indexCpHref = (cpId: string): string => `/?cp=${cpId}`;
export const INDEX_CP_QUERY_PARAM = 'cp';

// Index map deep-link: pan/zoom and open the popup for a specific station.
export const indexStationHref = (stationId: string): string => `/?station=${stationId}`;
export const INDEX_STATION_QUERY_PARAM = 'station';
