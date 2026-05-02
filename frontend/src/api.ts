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
export type ApiMapMeasurement = Schemas['MapMeasurement'];
export type ApiImageMeasurement = Schemas['ImageMeasurement'];
export type ApiControlPoint = Schemas['ControlPoint'];
export type ApiHydratedStation = Schemas['HydratedStation'];
export type PhotoPosePatch = Schemas['PhotoPosePatch'];
export type MapMeasurementRequest = Schemas['MapMeasurementRequest'];
export type ImageMeasurementPatch = Schemas['ImageMeasurementPatch'];
export type ControlPointPatch = Schemas['ControlPointPatch'];
export type ApiControlPointObservations = Schemas['ControlPointObservations'];

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

export function createStation(latlng: LatLng, name?: string): Promise<ApiStation> {
  return request<ApiStation>('POST', '/stations', { lat: latlng.lat, lng: latlng.lng, name: name ?? null });
}

export function listStations(): Promise<ApiStation[]> {
  return request<ApiStation[]>('GET', '/stations');
}

export function getStation(id: string): Promise<ApiHydratedStation> {
  return request<ApiHydratedStation>('GET', `/stations/${encodeURIComponent(id)}`);
}

export function updateStation(id: string, latlng: LatLng, name?: string | null): Promise<ApiStation> {
  return request<ApiStation>('PUT', `/stations/${encodeURIComponent(id)}`, {
    lat: latlng.lat, lng: latlng.lng, name: name ?? null,
  });
}

export function deleteStation(id: string): Promise<void> {
  return requestVoid('DELETE', `/stations/${encodeURIComponent(id)}`);
}

// --- Photos ---

export function createPhoto(stationId: string, init: PhotoPosePatch): Promise<ApiPhoto> {
  return request<ApiPhoto>('POST', `/stations/${encodeURIComponent(stationId)}/photos`, init);
}

export function updatePhoto(id: string, pose: PhotoPosePatch): Promise<ApiPhoto> {
  return request<ApiPhoto>('PUT', `/photos/${encodeURIComponent(id)}`, pose);
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

// --- Map measurements ---

export function createMapMeasurement(body: MapMeasurementRequest): Promise<ApiMapMeasurement> {
  return request<ApiMapMeasurement>('POST', '/map-measurements', body);
}

export function listMapMeasurements(): Promise<ApiMapMeasurement[]> {
  return request<ApiMapMeasurement[]>('GET', '/map-measurements');
}

export function updateMapMeasurement(
  id: string, body: MapMeasurementRequest,
): Promise<ApiMapMeasurement> {
  return request<ApiMapMeasurement>('PUT', `/map-measurements/${encodeURIComponent(id)}`, body);
}

export function deleteMapMeasurement(id: string): Promise<void> {
  return requestVoid('DELETE', `/map-measurements/${encodeURIComponent(id)}`);
}

// --- Image measurements ---

export function createImageMeasurement(
  photoId: string, init: ImageMeasurementPatch,
): Promise<ApiImageMeasurement> {
  return request<ApiImageMeasurement>('POST', `/photos/${encodeURIComponent(photoId)}/image-measurements`, init);
}

export function updateImageMeasurement(
  id: string, patch: ImageMeasurementPatch,
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
