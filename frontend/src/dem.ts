// Shared DEM tile fetcher and Web-Mercator coordinate helpers. Fetches AWS
// Open Data Terrain Tiles (Terrarium PNG encoding), decodes elevations once,
// and caches by (z, x, y) so the 3D terrain mesh and the Leaflet hillshade
// layer don't re-fetch.
//
// Tile source: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
// Encoding:    elevation_meters = R * 256 + G + B / 256 - 32768

import { createTileCache } from './tile-cache.js';

export const TILE_PX = 256;

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// 128 entries × 256 KB per decoded tile ≈ 32 MB cap.
const cache = createTileCache<Float32Array>(128);

export function tileKey(z: number, x: number, y: number): string {
  return `${z.toString()}/${x.toString()}/${y.toString()}`;
}

export function fetchTileElevations(
  z: number,
  x: number,
  y: number,
): Promise<Float32Array | null> {
  const k = tileKey(z, x, y);
  return cache.fetch(k, async () => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = (): void => { resolve(); };
        img.onerror = (): void => { reject(new Error(`Failed to load DEM ${k}`)); };
        img.src = `${TILE_URL}/${k}.png`;
      });
    } catch (err) {
      console.warn('[dem] tile fetch failed:', err);
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = TILE_PX;
    canvas.height = TILE_PX;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;

    const elev = new Float32Array(TILE_PX * TILE_PX);
    for (let i = 0; i < elev.length; i++) {
      const r = pixels[i * 4]!;
      const g = pixels[i * 4 + 1]!;
      const b = pixels[i * 4 + 2]!;
      elev[i] = r * 256 + g + b / 256 - 32768;
    }
    return elev;
  });
}

// --- Web-Mercator tile-coordinate helpers ---

export function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const sinLat = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * 2 ** z;
}

export function tileXToLng(tileX: number, z: number): number {
  return (tileX / 2 ** z) * 360 - 180;
}

export function tileYToLat(tileY: number, z: number): number {
  const n = Math.PI - 2 * Math.PI * tileY / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
