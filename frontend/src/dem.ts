// Shared DEM tile fetcher and Web-Mercator coordinate helpers. Fetches AWS
// Open Data Terrain Tiles (Terrarium PNG encoding), decodes elevations once,
// and caches by (z, x, y) so the 3D terrain mesh and the Leaflet hillshade
// layer don't re-fetch.
//
// Tile source: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
// Encoding:    elevation_meters = R * 256 + G + B / 256 - 32768

import { createTileCache } from './tile-cache.js';
import { degToRad, radToDeg } from './mathx.js';

export const TILE_PX = 256;

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// 256 entries × 256 KB per decoded tile ≈ 64 MB cap. Sized to hold one
// full progressive rebuild (175 unique DEM tiles across 7 rings) plus
// headroom so the next mode-toggle rebuild hits cache.
const cache = createTileCache<Float32Array>(256);

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
    let bitmap: ImageBitmap;
    try {
      const res = await fetch(`${TILE_URL}/${k}.png`);
      if (!res.ok) throw new Error(`HTTP ${res.status.toString()}`);
      // colorSpaceConversion:'none' + premultiplyAlpha:'none' keeps the raw
      // 8-bit PNG bytes intact. The Terrarium encoding packs elevation as
      // R*256 + G + B/256, so any browser color-management nudge on R is
      // worth 256 m per unit — that's what shows up as isolated downward
      // pixel spikes at the pixels where the round-trip would have flipped a
      // byte. Decoding via createImageBitmap with these flags (rather than
      // HTMLImageElement + drawImage) bypasses the color-managed path.
      bitmap = await createImageBitmap(await res.blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
    } catch (err) {
      console.warn('[dem] tile fetch failed:', err);
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = TILE_PX;
    canvas.height = TILE_PX;
    // willReadFrequently: software-backed canvas. The GPU-backed path can
    // also subtly perturb readback bytes; the software backend is bit-exact.
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;

    const elev = new Float32Array(TILE_PX * TILE_PX);
    for (let i = 0; i < elev.length; i++) {
      const r = pixels[i * 4]!;
      const g = pixels[i * 4 + 1]!;
      const b = pixels[i * 4 + 2]!;
      const e = r * 256 + g + b / 256 - 32768;
      // Real Earth elevations live in roughly [-432, 8848] m; the Terrarium
      // encoding can produce values down to -32768. Mark anything beyond a
      // generous land envelope as no-data so the geometry can substitute a
      // plane-level fallback instead of rendering a kilometre-deep spike.
      // Bathymetry rules out a -1500 floor in coastal scenes but this app
      // photographs land, and the alternative is unboundedly tall artifacts.
      elev[i] = (e < -1500 || e > 9000) ? NaN : e;
    }
    return elev;
  });
}

// --- Web-Mercator tile-coordinate helpers ---

export function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const sinLat = Math.sin(degToRad(lat));
  return (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * 2 ** z;
}

export function tileXToLng(tileX: number, z: number): number {
  return (tileX / 2 ** z) * 360 - 180;
}

export function tileYToLat(tileY: number, z: number): number {
  const n = Math.PI - 2 * Math.PI * tileY / 2 ** z;
  return radToDeg(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
}

