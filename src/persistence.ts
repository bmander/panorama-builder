// Browser-side persistence via IndexedDB. State stays per-origin; refresh
// preserves the user's work. Falls back to a no-op store if IDB is missing
// or fails to open (private mode, quota, etc.) so the app never crashes
// on load.

import type { LatLng } from './types.js';

const DB_NAME = 'panorama-builder-v1';
const DB_VERSION = 1;
const STATE_STORE = 'state';
const BLOBS_STORE = 'blobs';
const SINGLETON_KEY = 'app';
const DEBOUNCE_MS = 500;

export interface OverlaySnapshot {
  id: string;
  sizeRad: number;
  aspect: number;
  photoAz: number;
  photoTilt: number;
  // In-plane roll (radians). Optional for back-compat; missing → 0.
  photoRoll?: number;
  // Body opacity in [0, 1]. Optional for back-compat with snapshots written
  // before the per-photo opacity slider existed; missing → fully opaque.
  opacity?: number;
  pois: { u: number; v: number; mapAnchor: LatLng | null }[];
}

export interface AppSnapshot {
  version: 1;
  camLoc: LatLng | null;
  azimuth: number;
  altitude: number;
  fov: number;
  tab: '360' | 'flat' | 'map';
  lockCamera: boolean;
  // Legacy boolean — superseded by terrainMode. Kept readable for back-compat
  // so old snapshots restore as 'wireframe' if true.
  terrainEnabled?: boolean;
  terrainMode?: 'off' | 'wireframe' | 'shaded';
  // ISO datetime string (no timezone — interpreted as local civil time, matching
  // the <input type="datetime-local"> value format).
  sunDateTime?: string;
  // FogExp2 density per meter for the atmospheric haze. Optional for back-compat.
  hazeDensity?: number;
  // Earth-curvature drop on terrain. Optional for back-compat (defaults to on).
  curvatureEnabled?: boolean;
  // Atmospheric refraction correction. Only meaningful when curvatureEnabled.
  refractionEnabled?: boolean;
  // Camera height above local ground (terrain feature). Optional for back-compat.
  cameraHeight?: number;
  overlays: OverlaySnapshot[];
}

export interface Store {
  saveBlob(id: string, blob: Blob): Promise<void>;
  scheduleSave(getSnapshot: () => AppSnapshot): void;
  loadAll(): Promise<{ snapshot: AppSnapshot; blobs: Map<string, Blob> } | null>;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (): void => { resolve(req.result); };
    req.onerror = (): void => { reject(req.error ?? new Error('IDB request failed')); };
  });
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(BLOBS_STORE)) db.createObjectStore(BLOBS_STORE);
    };
    req.onsuccess = (): void => { resolve(req.result); };
    req.onerror = (): void => { reject(req.error ?? new Error('Failed to open IDB')); };
    req.onblocked = (): void => { console.warn('[persistence] open blocked by another connection'); };
  });
}

export async function openStore(): Promise<Store | null> {
  if (typeof indexedDB === 'undefined') return null;
  let db: IDBDatabase;
  try {
    db = await openDB();
  } catch (err) {
    console.warn('[persistence] IndexedDB open failed; running without persistence:', err);
    return null;
  }

  async function saveBlob(id: string, blob: Blob): Promise<void> {
    const tx = db.transaction(BLOBS_STORE, 'readwrite');
    tx.objectStore(BLOBS_STORE).put(blob, id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = (): void => { resolve(); };
      tx.onerror = (): void => { reject(tx.error ?? new Error('saveBlob failed')); };
      tx.onabort = (): void => { reject(tx.error ?? new Error('saveBlob aborted')); };
    });
  }

  async function writeSnapshot(snapshot: AppSnapshot): Promise<void> {
    const tx = db.transaction([STATE_STORE, BLOBS_STORE], 'readwrite');
    const stateStore = tx.objectStore(STATE_STORE);
    const blobStore = tx.objectStore(BLOBS_STORE);
    stateStore.put(snapshot, SINGLETON_KEY);

    // Drop any blob whose id is no longer in the snapshot (overlay was deleted).
    const wantedIds = new Set(snapshot.overlays.map(o => o.id));
    const allKeys = await promisify(blobStore.getAllKeys());
    for (const key of allKeys) {
      if (typeof key === 'string' && !wantedIds.has(key)) blobStore.delete(key);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = (): void => { resolve(); };
      tx.onerror = (): void => { reject(tx.error ?? new Error('saveSnapshot failed')); };
      tx.onabort = (): void => { reject(tx.error ?? new Error('saveSnapshot aborted')); };
    });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSave(getSnapshot: () => AppSnapshot): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      writeSnapshot(getSnapshot()).catch((err: unknown) => {
        console.warn('[persistence] save failed:', err);
      });
    }, DEBOUNCE_MS);
  }

  async function loadAll(): Promise<{ snapshot: AppSnapshot; blobs: Map<string, Blob> } | null> {
    const tx = db.transaction([STATE_STORE, BLOBS_STORE], 'readonly');
    const raw: unknown = await promisify(tx.objectStore(STATE_STORE).get(SINGLETON_KEY));
    if (!isAppSnapshot(raw)) return null;

    const blobStore = tx.objectStore(BLOBS_STORE);
    const blobs = new Map<string, Blob>();
    for (const o of raw.overlays) {
      const blob: unknown = await promisify(blobStore.get(o.id));
      if (blob instanceof Blob) blobs.set(o.id, blob);
    }
    return { snapshot: raw, blobs };
  }

  return { saveBlob, scheduleSave, loadAll };
}

// Loose runtime check: anything that doesn't look like a v1 snapshot we
// treat as missing — better to start clean than to half-restore garbage.
function isAppSnapshot(v: unknown): v is AppSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return obj.version === 1 && Array.isArray(obj.overlays);
}
