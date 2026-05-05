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

const API = '/api';

type Schemas = components['schemas'];

export type ApiStation = Schemas['Station'];
export type ApiPhoto = Schemas['Photo'];
export type ApiImageMeasurement = Schemas['ImageMeasurement'];
export type ApiControlPoint = Schemas['ControlPoint'];
export type ApiHydratedStation = Schemas['HydratedStation'];
export type PhotoPosePatch = Schemas['PhotoPosePatch'];
export type ImageMeasurementPatch = Schemas['ImageMeasurementPatch'];
export type ControlPointPatch = Schemas['ControlPointPatch'];
export type StationUpdate = Schemas['StationUpdate'];
export type PhotoUpdate = Schemas['PhotoUpdate'];
export type ImageMeasurementUpdate = Schemas['ImageMeasurementUpdate'];
export type ApiControlPointObservations = Schemas['ControlPointObservations'];
export type SolveConfig = Schemas['SolveConfig'];
export type SolveResult = Schemas['SolveResult'];
export type EntityChange = Schemas['EntityChange'];

// --- Helpers ---

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status.toString()} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function requestVoid(method: string, path: string): Promise<void> {
  const res = await fetch(API + path, { method });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status.toString()} ${text}`);
  }
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
  return request<ApiStation>('PUT', `/stations/${encodeURIComponent(id)}`, patch);
}

export function deleteStation(id: string): Promise<void> {
  return requestVoid('DELETE', `/stations/${encodeURIComponent(id)}`);
}

// --- Photos ---

export function createPhoto(stationId: string, init: PhotoPosePatch): Promise<ApiPhoto> {
  return request<ApiPhoto>('POST', `/stations/${encodeURIComponent(stationId)}/photos`, init);
}

export function updatePhoto(id: string, patch: PhotoUpdate): Promise<ApiPhoto> {
  return request<ApiPhoto>('PUT', `/photos/${encodeURIComponent(id)}`, patch);
}

export function deletePhoto(id: string): Promise<void> {
  return requestVoid('DELETE', `/photos/${encodeURIComponent(id)}`);
}

export async function uploadPhotoBlob(id: string, blob: Blob): Promise<void> {
  const res = await fetch(`${API}/photos/${encodeURIComponent(id)}/blob`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'image/jpeg' },
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PUT /photos/${id}/blob → ${res.status.toString()} ${text}`);
  }
}

// URL the browser can use directly (e.g., as a TextureLoader source).
export function photoBlobUrl(id: string): string {
  return `${API}/photos/${encodeURIComponent(id)}/blob`;
}

// --- Image measurements ---

export function createImageMeasurement(
  photoId: string, init: ImageMeasurementPatch,
): Promise<ApiImageMeasurement> {
  return request<ApiImageMeasurement>('POST', `/photos/${encodeURIComponent(photoId)}/image-measurements`, init);
}

export function updateImageMeasurement(
  id: string, patch: ImageMeasurementUpdate,
): Promise<ApiImageMeasurement> {
  return request<ApiImageMeasurement>('PUT', `/image-measurements/${encodeURIComponent(id)}`, patch);
}

export function deleteImageMeasurement(id: string): Promise<void> {
  return requestVoid('DELETE', `/image-measurements/${encodeURIComponent(id)}`);
}

// --- Control points ---

export function createControlPoint(body: ControlPointPatch): Promise<ApiControlPoint> {
  return request<ApiControlPoint>('POST', '/control-points', body);
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

export function updateControlPoint(id: string, body: ControlPointPatch): Promise<ApiControlPoint> {
  return request<ApiControlPoint>('PUT', `/control-points/${encodeURIComponent(id)}`, body);
}

export function deleteControlPoint(id: string): Promise<void> {
  return requestVoid('DELETE', `/control-points/${encodeURIComponent(id)}`);
}

// --- Solver ---

export function solveJoint(config?: SolveConfig): Promise<SolveResult> {
  return request<SolveResult>('POST', '/solve/joint', config ?? {});
}

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

export async function solveJointStream(
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
    res = await fetch(`${API}/solve/joint/stream`, init);
  } catch (err) {
    handleAbort(err);
    return;
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /solve/joint/stream → ${res.status.toString()} ${text}`);
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

// Signal an in-flight streaming solve to stop gracefully — the solver
// returns the best iterate so far and the server writes it back. 404 if no
// solve is currently running (caller should treat as no-op).
export async function solveJointStop(): Promise<void> {
  const res = await fetch(`${API}/solve/joint/stop`, { method: 'POST' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /solve/joint/stop → ${res.status.toString()} ${text}`);
  }
}

export function solveStation(id: string, config?: SolveConfig): Promise<SolveResult> {
  return request<SolveResult>('POST', `/solve/stations/${encodeURIComponent(id)}`, config ?? {});
}

export function solveControlPoint(id: string, config?: SolveConfig): Promise<SolveResult> {
  return request<SolveResult>('POST', `/solve/control-points/${encodeURIComponent(id)}`, config ?? {});
}
