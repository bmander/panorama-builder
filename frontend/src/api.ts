// Typed fetch wrappers around the Go backend at /api/*. Hand-rolled, no dep.
// Server-assigned IDs throughout: every create returns the new entity with
// its id; updates and deletes take the id as a path param.
//
// Wire shapes are imported from api-types.gen.ts which is regenerated from
// ../../openapi.yaml via `make generate` (or `npm run generate-types`). The
// `Api*` aliases here are the call-site-facing names — keeping them stable
// avoids churn in main.ts / sync.ts / handlers.ts on spec changes.

import type { LatLng } from './types.js';
import type { components } from './api-types.gen.js';
import { sessionManager } from './session.js';
import { sessionPending } from './session-pending.js';

const API = '/api';

type Schemas = components['schemas'];

export type ApiStation = Schemas['Station'];
export type ApiPhoto = Schemas['Photo'];
export type ApiPhotoListItem = Schemas['PhotoListItem'];
export type ApiImageMeasurement = Schemas['ImageMeasurement'];
export type ApiControlPoint = Schemas['ControlPoint'];
export type ApiHydratedStation = Schemas['HydratedStation'];
export type PhotoPosePatch = Schemas['PhotoPosePatch'];
export type ImageMeasurementPatch = Schemas['ImageMeasurementPatch'];
export type ControlPointPatch = Schemas['ControlPointPatch'];
export type StationUpdate = Schemas['StationUpdate'];
export type PhotoUpdate = Schemas['PhotoUpdate'];
export type ImageMeasurementUpdate = Schemas['ImageMeasurementUpdate'];
export type ApiCPConstraint = Schemas['CPConstraint'];
export type ApiCPConstraintCreate = Schemas['CPConstraintCreate'];
export type ApiCPConstraintPatch = Schemas['CPConstraintPatch'];
export type ApiCPConstraintType = Schemas['CPConstraintType'];
export type ApiCPSurface = Schemas['CPSurface'];
export type ApiCPSurfaceCreate = Schemas['CPSurfaceCreate'];
export type ApiControlPointObservations = Schemas['ControlPointObservations'];
export type ApiControlPointImageObservation = Schemas['ControlPointImageObservation'];
export type ApiControlPointVisiblePhotos = Schemas['ControlPointVisiblePhotos'];
export type ApiControlPointVisiblePhoto = Schemas['ControlPointVisiblePhoto'];
export type ApiControlPointFits = Schemas['ControlPointFits'];
export type ApiControlPointFit = Schemas['ControlPointFit'];
export type SolveConfig = Schemas['SolveConfig'];
export type SolveResult = Schemas['SolveResult'];
export type EntityChange = Schemas['EntityChange'];
export type ApiSessionState = Schemas['SessionState'];
export type ApiSessionOp = Schemas['SessionOp'];
export type ApiCreateSessionResponse = Schemas['CreateSessionResponse'];
export type ApiCommitRef = Schemas['CommitRef'];
export type ApiCommit = Schemas['Commit'];
export type ApiCommitWithOps = Schemas['CommitWithOps'];
export type ApiEntityRef = Schemas['EntityRef'];
export type ApiMergeRequest = Schemas['MergeRequest'];
export type ApiRevertRequest = Schemas['RevertRequest'];

// SessionRankDeficientError: thrown by mergeSession on a 422 with the
// per-entity σ list from backend/merge_gate.go. Caller decides whether to
// surface the list and let the user resubmit with allow_underdetermined.
export class SessionRankDeficientError extends Error {
  constructor(
    readonly deficientAxes: readonly components['schemas']['RankDeficientAxis'][],
  ) {
    super(`rank-deficient: ${deficientAxes.length.toString()} entit${deficientAxes.length === 1 ? 'y' : 'ies'} flagged`);
    this.name = 'SessionRankDeficientError';
  }
}

// SessionConflictError: thrown by mergeSession / revertCommit on a 409 with
// a conflict list. Callers can branch on `instanceof` to render the conflict
// UI rather than parsing the message.
export class SessionConflictError extends Error {
  constructor(public readonly conflicts: ApiEntityRef[], message: string) {
    super(message);
    this.name = 'SessionConflictError';
  }
}

// --- Helpers ---

// withSession adds the X-Session-Id header when a session is active.
function withSession(init: RequestInit): RequestInit {
  const sid = sessionManager.current();
  if (sid === null) return init;
  const headers = new Headers(init.headers);
  headers.set('X-Session-Id', sid);
  return { ...init, headers };
}

// Any non-GET request auto-starts a session before firing, so writes can't
// silently land on main. The session/commit endpoints themselves are the
// exception — otherwise createSession would recurse.
function pathManagesSession(path: string): boolean {
  return path.startsWith('/sessions') || path.startsWith('/commits');
}

async function ensureSessionForWrite(method: string, path: string): Promise<void> {
  if (method === 'GET') return;
  if (pathManagesSession(path)) return;
  await sessionManager.ensureStarted();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  await ensureSessionForWrite(method, path);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, withSession(init));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status.toString()} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function requestVoid(method: string, path: string): Promise<void> {
  await ensureSessionForWrite(method, path);
  const res = await fetch(API + path, withSession({ method }));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status.toString()} ${text}`);
  }
}

// Tag a write that affects solver inputs so the session widget can count it.
// Wraps a request promise; only bumps on success.
function bump<T>(p: Promise<T>): Promise<T> {
  return p.then(v => { sessionPending.bumpUser(); return v; });
}

// --- Stations ---

export function createStation(latlng: LatLng, capturedAt: string, name?: string): Promise<ApiStation> {
  return request<ApiStation>('POST', '/stations', {
    lat: latlng.lat,
    lng: latlng.lng,
    captured_at: capturedAt,
    name: name ?? null,
  });
}

export function listStations(): Promise<ApiStation[]> {
  return request<ApiStation[]>('GET', '/stations');
}

export function getStation(id: string): Promise<ApiHydratedStation> {
  return request<ApiHydratedStation>('GET', `/stations/${encodeURIComponent(id)}`);
}

export function updateStation(id: string, patch: StationUpdate): Promise<ApiStation> {
  return bump(request<ApiStation>('PUT', `/stations/${encodeURIComponent(id)}`, patch));
}

export function deleteStation(id: string): Promise<void> {
  return requestVoid('DELETE', `/stations/${encodeURIComponent(id)}`);
}

// --- Photos ---

export function listPhotos(): Promise<ApiPhotoListItem[]> {
  return request<ApiPhotoListItem[]>('GET', '/photos');
}

export function createPhoto(stationId: string, init: PhotoPosePatch): Promise<ApiPhoto> {
  return request<ApiPhoto>('POST', `/stations/${encodeURIComponent(stationId)}/photos`, init);
}

export function updatePhoto(id: string, patch: PhotoUpdate): Promise<ApiPhoto> {
  return bump(request<ApiPhoto>('PUT', `/photos/${encodeURIComponent(id)}`, patch));
}

export function deletePhoto(id: string): Promise<void> {
  return requestVoid('DELETE', `/photos/${encodeURIComponent(id)}`);
}

export async function uploadPhotoBlob(id: string, blob: Blob): Promise<void> {
  await sessionManager.ensureStarted();
  const path = `/photos/${encodeURIComponent(id)}/blob`;
  const res = await fetch(API + path, withSession({
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'image/jpeg' },
    body: blob,
  }));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PUT ${path} → ${res.status.toString()} ${text}`);
  }
}

const BLOB_PATH_RE = /^blobs\/([0-9a-f]{64})$/;

// Returns the content-addressed `/blobs/{hash}` URL when blob_path is in
// the new form, else falls back to `/photos/{id}/blob`. The fallback only
// resolves rows visible in `main`; callers handling session-pending photos
// must supply blob_path so the hash URL is used.
export function photoBlobUrl(photo: Pick<ApiPhoto, 'id' | 'blob_path'>): string {
  const m = photo.blob_path && BLOB_PATH_RE.exec(photo.blob_path);
  if (m) return `${API}/blobs/${m[1]}`;
  return `${API}/photos/${encodeURIComponent(photo.id)}/blob`;
}

// Returns null for legacy / session-pending rows without a hash-form
// blob_path — callers must fall back to photoBlobUrl.
export function photoPreviewUrl(photo: Pick<ApiPhoto, 'blob_path'>): string | null {
  const m = photo.blob_path && BLOB_PATH_RE.exec(photo.blob_path);
  return m ? `${API}/blobs/${m[1]}/preview` : null;
}

// --- Image measurements ---

export function createImageMeasurement(
  photoId: string, init: ImageMeasurementPatch,
): Promise<ApiImageMeasurement> {
  return bump(request<ApiImageMeasurement>('POST', `/photos/${encodeURIComponent(photoId)}/image-measurements`, init));
}

export function updateImageMeasurement(
  id: string, patch: ImageMeasurementUpdate,
): Promise<ApiImageMeasurement> {
  return bump(request<ApiImageMeasurement>('PUT', `/image-measurements/${encodeURIComponent(id)}`, patch));
}

export function deleteImageMeasurement(id: string): Promise<void> {
  return bump(requestVoid('DELETE', `/image-measurements/${encodeURIComponent(id)}`));
}

// --- Control points ---

export function createControlPoint(body: ControlPointPatch): Promise<ApiControlPoint> {
  return bump(request<ApiControlPoint>('POST', '/control-points', body));
}

export function listControlPoints(): Promise<ApiControlPoint[]> {
  return request<ApiControlPoint[]>('GET', '/control-points');
}

export function getControlPoint(id: string): Promise<ApiControlPoint> {
  return request<ApiControlPoint>('GET', `/control-points/${encodeURIComponent(id)}`);
}

export function listControlPointObservations(id: string): Promise<ApiControlPointObservations> {
  return request<ApiControlPointObservations>(
    'GET', `/control-points/${encodeURIComponent(id)}/observations`,
  );
}

export function listControlPointVisiblePhotos(id: string): Promise<ApiControlPointVisiblePhotos> {
  return request<ApiControlPointVisiblePhotos>(
    'GET', `/control-points/${encodeURIComponent(id)}/visible-photos`,
  );
}

export function listControlPointFits(): Promise<ApiControlPointFits> {
  return request<ApiControlPointFits>('GET', '/control-point-fits');
}

export function updateControlPoint(id: string, body: ControlPointPatch): Promise<ApiControlPoint> {
  return bump(request<ApiControlPoint>('PUT', `/control-points/${encodeURIComponent(id)}`, body));
}

export function deleteControlPoint(id: string): Promise<void> {
  return bump(requestVoid('DELETE', `/control-points/${encodeURIComponent(id)}`));
}

// --- Control point constraints ---

export function createCPConstraint(body: ApiCPConstraintCreate): Promise<ApiCPConstraint> {
  return request<ApiCPConstraint>('POST', '/control-point-constraints', body);
}

export function listCPConstraints(): Promise<ApiCPConstraint[]> {
  return request<ApiCPConstraint[]>('GET', '/control-point-constraints');
}

export function updateCPConstraint(id: string, patch: ApiCPConstraintPatch): Promise<ApiCPConstraint> {
  return request<ApiCPConstraint>('PUT', `/control-point-constraints/${encodeURIComponent(id)}`, patch);
}

export function deleteCPConstraint(id: string): Promise<void> {
  return requestVoid('DELETE', `/control-point-constraints/${encodeURIComponent(id)}`);
}

// --- Control point surfaces ---

export function createCPSurface(body: ApiCPSurfaceCreate): Promise<ApiCPSurface> {
  return request<ApiCPSurface>('POST', '/control-point-surfaces', body);
}

export function listCPSurfaces(): Promise<ApiCPSurface[]> {
  return request<ApiCPSurface[]>('GET', '/control-point-surfaces');
}

export function deleteCPSurface(id: string): Promise<void> {
  return requestVoid('DELETE', `/control-point-surfaces/${encodeURIComponent(id)}`);
}

// --- Solver ---

// Streaming variant: one event per GN iteration, then a final terminal
// event. The promise resolves when the stream closes (which happens after
// the final event, or when the caller aborts via signal). Pass an
// AbortSignal to support a Cancel button — the underlying fetch is aborted,
// the server detects the disconnect, and the in-flight solve breaks early
// without writing anything back.
export type SolveProgressEvent =
  | { readonly kind: 'iter'; readonly iter: number; readonly rms: number; readonly accepted: boolean }
  | { readonly kind: 'done'; readonly result: SolveResult }
  | { readonly kind: 'stopped'; readonly result: SolveResult }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string };

export type RankDeficientAxis = components['schemas']['RankDeficientAxis'];

async function solveStream(
  path: string,
  config: SolveConfig,
  onEvent: (e: SolveProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  // Abort can fire either during the initial fetch (TypeError from undici) or
  // mid-stream (AbortError from the reader). In both cases the caller wants
  // a single 'cancelled' event, not a thrown error to surface as a failure.
  const handleAbort = (err: unknown): void => {
    if (signal?.aborted) {
      onEvent({ kind: 'cancelled' });
      return;
    }
    throw err;
  };

  let res: Response;
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    };
    if (signal) init.signal = signal;
    res = await fetch(`${API}${path}`, withSession(init));
  } catch (err) {
    handleAbort(err);
    return;
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${path} → ${res.status.toString()} ${text}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Carry partial trailing event across reads — a chunk may split mid-event.
      let sepIdx = buf.indexOf('\n\n');
      while (sepIdx !== -1) {
        const block = buf.slice(0, sepIdx);
        buf = buf.slice(sepIdx + 2);
        const dataLine = block.split('\n').find(l => l.startsWith('data:'));
        if (dataLine) {
          try {
            onEvent(JSON.parse(dataLine.slice(5).trim()) as SolveProgressEvent);
          } catch (err) {
            console.error('solve stream parse failed:', err, dataLine);
          }
        }
        sepIdx = buf.indexOf('\n\n');
      }
    }
  } catch (err) {
    handleAbort(err);
  }
}

export function solveJointStream(
  config: SolveConfig,
  onEvent: (e: SolveProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return solveStream('/solve/joint/stream', config, onEvent, signal);
}

// Signal an in-flight streaming solve to stop gracefully — the solver
// returns the best iterate so far and the server writes it back. 404 if no
// solve is currently running (caller should treat as no-op). Shared across
// solver modes since only one runs at a time.
export async function solveStop(): Promise<void> {
  const res = await fetch(`${API}/solve/stop`, withSession({ method: 'POST' }));
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /solve/stop → ${res.status.toString()} ${text}`);
  }
}

// --- Sessions ---

export function createSession(): Promise<ApiCreateSessionResponse> {
  return request<ApiCreateSessionResponse>('POST', '/sessions');
}

export function getSession(id: string): Promise<ApiSessionState> {
  return request<ApiSessionState>('GET', `/sessions/${encodeURIComponent(id)}`);
}

export function getSessionOps(id: string): Promise<ApiSessionOp[]> {
  return request<ApiSessionOp[]>('GET', `/sessions/${encodeURIComponent(id)}/ops`);
}

export function abandonSession(id: string): Promise<void> {
  return requestVoid('POST', `/sessions/${encodeURIComponent(id)}/abandon`);
}

// getSessionRankDeficient asks the backend to dry-run the merge σ gate and
// return the per-entity flagged-axes list. Used by the session widget to
// surface "X problems" between Solve and Save.
export async function getSessionRankDeficient(id: string): Promise<readonly RankDeficientAxis[]> {
  const body = await request<{ deficient_axes: readonly RankDeficientAxis[] }>(
    'GET', `/sessions/${encodeURIComponent(id)}/rank-deficient`,
  );
  return body.deficient_axes;
}

// mergeSession: throws SessionConflictError on 409 so the caller can render
// a conflict UI instead of a generic error banner.
export async function mergeSession(id: string, body: ApiMergeRequest): Promise<ApiCommitRef> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const res = await fetch(`${API}/sessions/${encodeURIComponent(id)}/merge`, init);
  if (res.status === 409) {
    const body = await res.json().catch(() => ({ error: 'conflict', conflicts: [] })) as {
      error: string; conflicts?: ApiEntityRef[];
    };
    throw new SessionConflictError(body.conflicts ?? [], body.error);
  }
  if (res.status === 422) {
    const body = await res.json().catch(() => ({ deficient_axes: [] })) as {
      deficient_axes?: components['schemas']['RankDeficientAxis'][];
    };
    throw new SessionRankDeficientError(body.deficient_axes ?? []);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /sessions/${id}/merge → ${res.status.toString()} ${text}`);
  }
  return res.json() as Promise<ApiCommitRef>;
}

// --- Commits ---

export function listCommits(beforeSeq?: number, limit = 50): Promise<ApiCommit[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (beforeSeq !== undefined) params.set('before_seq', String(beforeSeq));
  return request<ApiCommit[]>('GET', `/commits?${params.toString()}`);
}

export function getCommit(id: string): Promise<ApiCommitWithOps> {
  return request<ApiCommitWithOps>('GET', `/commits/${encodeURIComponent(id)}`);
}

// revertCommit: requires a sign_off (same peppercorn rule as mergeSession);
// shares the conflict-as-error semantics.
export async function revertCommit(id: string, body: ApiRevertRequest): Promise<ApiCommitRef> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const res = await fetch(`${API}/commits/${encodeURIComponent(id)}/revert`, init);
  if (res.status === 409) {
    const body = await res.json().catch(() => ({ error: 'conflict', conflicts: [] })) as {
      error: string; conflicts?: ApiEntityRef[];
    };
    throw new SessionConflictError(body.conflicts ?? [], body.error);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /commits/${id}/revert → ${res.status.toString()} ${text}`);
  }
  return res.json() as Promise<ApiCommitRef>;
}

