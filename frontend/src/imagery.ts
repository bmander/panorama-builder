// Satellite imagery tile fetcher. Returns a decoded HTMLImageElement so the
// caller can drawImage() it into a composite canvas without re-decoding.
//
// Tile source: Esri World Imagery via the ArcGIS REST tile endpoint. Note the
// path order is {z}/{y}/{x} (row before column), unlike the standard XYZ
// convention dem.ts uses.

import { tileKey } from './dem.js';
import { createTileCache } from './tile-cache.js';

const TILE_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';

const cache = createTileCache<HTMLImageElement>(128);

export function fetchImageryTile(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  const k = tileKey(z, x, y);
  return cache.fetch(k, async () => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = (): void => { resolve(); };
        img.onerror = (): void => { reject(new Error(`Failed to load imagery ${k}`)); };
        img.src = `${TILE_URL}/${z.toString()}/${y.toString()}/${x.toString()}`;
      });
    } catch (err) {
      console.warn('[imagery] tile fetch failed:', err);
      return null;
    }
    return img;
  });
}
