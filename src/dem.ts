// Shared DEM tile fetcher. Fetches AWS Open Data Terrain Tiles (Terrarium PNG
// encoding), decodes elevations once, and caches by (z, x, y) so that consumers
// — the 3D terrain mesh and the Leaflet hillshade layer — don't re-fetch.
//
// Tile source: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
// Encoding:    elevation_meters = R * 256 + G + B / 256 - 32768

export const TILE_PX = 256;

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array | null>>();

function key(z: number, x: number, y: number): string {
  return `${z.toString()}/${x.toString()}/${y.toString()}`;
}

export function fetchTileElevations(
  z: number,
  x: number,
  y: number,
): Promise<Float32Array | null> {
  const k = key(z, x, y);
  const cached = cache.get(k);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(k);
  if (pending) return pending;

  const job = (async (): Promise<Float32Array | null> => {
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
    cache.set(k, elev);
    return elev;
  })();
  inflight.set(k, job);
  void job.finally(() => { inflight.delete(k); });
  return job;
}
