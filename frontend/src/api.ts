// Typed fetch wrappers around the Go backend at /api/*. Hand-rolled, no dep.
// Server-assigned IDs throughout: every create returns the new entity with
// its id; updates and deletes take the id as a path param.

import type { LatLng } from './types.js';

const API = '/api';

// --- Wire shapes (snake_case to match the backend JSON schema) ---

export interface ApiLocation {
  readonly id: string;
  readonly lat: number;
  readonly lng: number;
  readonly name: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ApiPhoto {
  readonly id: string;
  readonly location_id: string;
  readonly blob_path: string | null;
  readonly mime_type: string | null;
  readonly size_bytes: number | null;
  readonly aspect: number;
  readonly photo_az: number;
  readonly photo_tilt: number;
  readonly photo_roll: number;
  readonly size_rad: number;
  readonly opacity: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ApiMapPOI {
  readonly id: string;
  readonly location_id: string;
  readonly lat: number;
  readonly lng: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ApiImagePOI {
  readonly id: string;
  readonly photo_id: string;
  readonly u: number;
  readonly v: number;
  readonly map_poi_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ApiHydratedLocation {
  readonly location: ApiLocation;
  readonly photos: readonly ApiPhoto[];
  readonly map_pois: readonly ApiMapPOI[];
  readonly image_pois: readonly ApiImagePOI[];
}

// --- Request shapes ---

export interface PhotoPosePatch {
  readonly aspect: number;
  readonly photo_az: number;
  readonly photo_tilt: number;
  readonly photo_roll: number;
  readonly size_rad: number;
  readonly opacity?: number;
}

export interface ImagePOIPatch {
  readonly u: number;
  readonly v: number;
  readonly map_poi_id?: string | null;
}

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

// --- Locations ---

export function createLocation(latlng: LatLng, name?: string): Promise<ApiLocation> {
  return request<ApiLocation>('POST', '/locations', { lat: latlng.lat, lng: latlng.lng, name: name ?? null });
}

export function listLocations(): Promise<ApiLocation[]> {
  return request<ApiLocation[]>('GET', '/locations');
}

export function getLocation(id: string): Promise<ApiHydratedLocation> {
  return request<ApiHydratedLocation>('GET', `/locations/${encodeURIComponent(id)}`);
}

export function updateLocation(id: string, latlng: LatLng, name?: string | null): Promise<ApiLocation> {
  return request<ApiLocation>('PUT', `/locations/${encodeURIComponent(id)}`, {
    lat: latlng.lat, lng: latlng.lng, name: name ?? null,
  });
}

export function deleteLocation(id: string): Promise<void> {
  return requestVoid('DELETE', `/locations/${encodeURIComponent(id)}`);
}

// --- Photos ---

export function createPhoto(locationId: string, init: PhotoPosePatch): Promise<ApiPhoto> {
  return request<ApiPhoto>('POST', `/locations/${encodeURIComponent(locationId)}/photos`, init);
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

// --- Map POIs ---

export function createMapPOI(locationId: string, latlng: LatLng): Promise<ApiMapPOI> {
  return request<ApiMapPOI>('POST', `/locations/${encodeURIComponent(locationId)}/map-pois`, {
    lat: latlng.lat, lng: latlng.lng,
  });
}

export function updateMapPOI(id: string, latlng: LatLng): Promise<ApiMapPOI> {
  return request<ApiMapPOI>('PUT', `/map-pois/${encodeURIComponent(id)}`, {
    lat: latlng.lat, lng: latlng.lng,
  });
}

export function deleteMapPOI(id: string): Promise<void> {
  return requestVoid('DELETE', `/map-pois/${encodeURIComponent(id)}`);
}

// --- Image POIs ---

export function createImagePOI(photoId: string, init: ImagePOIPatch): Promise<ApiImagePOI> {
  return request<ApiImagePOI>('POST', `/photos/${encodeURIComponent(photoId)}/image-pois`, init);
}

export function updateImagePOI(id: string, patch: ImagePOIPatch): Promise<ApiImagePOI> {
  return request<ApiImagePOI>('PUT', `/image-pois/${encodeURIComponent(id)}`, patch);
}

export function deleteImagePOI(id: string): Promise<void> {
  return requestVoid('DELETE', `/image-pois/${encodeURIComponent(id)}`);
}
