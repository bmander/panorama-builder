import {
  TILE_PX,
  fetchTileElevations,
  latToTileY,
  lngToTileX,
  tileKey,
} from './dem.js';
import { fetchImageryTile } from './imagery.js';
import type { LatLng } from './types.js';
import type { RingSpec } from './terrain-geometry.js';

// Fallback fill for the imagery canvas when individual tiles fail to load.
const IMAGERY_FALLBACK = '#888';

export interface ImageryTilePlacement {
  tx: number;
  ty: number;
  img: HTMLImageElement | null;
}

export interface RingTiles {
  demTiles: Map<string, Float32Array>;
  imageryTiles: ImageryTilePlacement[];
}

function ringCenter(camLoc: LatLng, zoom: number): { cx: number; cy: number } {
  return {
    cx: Math.floor(lngToTileX(camLoc.lng, zoom)),
    cy: Math.floor(latToTileY(camLoc.lat, zoom)),
  };
}

export async function loadRingTiles(camLoc: LatLng, spec: RingSpec): Promise<RingTiles> {
  const { zoom, radiusTiles } = spec;
  const { cx, cy } = ringCenter(camLoc, zoom);

  const demPromises: Promise<{ tx: number; ty: number; data: Float32Array | null }>[] = [];
  const imageryPromises: Promise<ImageryTilePlacement>[] = [];
  for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
    for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
      const tx = cx + dx;
      const ty = cy + dy;
      demPromises.push(fetchTileElevations(zoom, tx, ty).then(data => ({ tx, ty, data })));
      imageryPromises.push(fetchImageryTile(zoom, tx, ty).then(img => ({ tx, ty, img })));
    }
  }
  const [tiles, imageryTiles] = await Promise.all([
    Promise.all(demPromises),
    Promise.all(imageryPromises),
  ]);

  const demTiles = new Map<string, Float32Array>();
  for (const t of tiles) {
    if (t.data) demTiles.set(tileKey(zoom, t.tx, t.ty), t.data);
  }

  return { demTiles, imageryTiles };
}

// Fire-and-forget: warms dem.ts / imagery.ts inflight caches so outer-ring
// network requests overlap with inner-ring geometry work.
export function prefetchRingTiles(camLoc: LatLng, spec: RingSpec): void {
  const { zoom, radiusTiles } = spec;
  const { cx, cy } = ringCenter(camLoc, zoom);
  for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
    for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
      void fetchTileElevations(zoom, cx + dx, cy + dy);
      void fetchImageryTile(zoom, cx + dx, cy + dy);
    }
  }
}

// Tile (cx-R, cy-R) lands at the canvas's top-left, matching how UVs are
// assigned by buildRingGeometry (UV.y=0 → vertex j=0 → northernmost row → top
// of canvas).
export function stitchImageryCanvas(
  camLoc: LatLng,
  spec: RingSpec,
  imageryTiles: readonly ImageryTilePlacement[],
): HTMLCanvasElement {
  const { radiusTiles, zoom } = spec;
  const { cx, cy } = ringCenter(camLoc, zoom);
  const canvasSize = TILE_PX * (radiusTiles * 2 + 1);
  const canvas = document.createElement('canvas');
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = IMAGERY_FALLBACK;
  ctx.fillRect(0, 0, canvasSize, canvasSize);
  for (const t of imageryTiles) {
    if (!t.img) continue;
    const ox = (t.tx - (cx - radiusTiles)) * TILE_PX;
    const oy = (t.ty - (cy - radiusTiles)) * TILE_PX;
    ctx.drawImage(t.img, ox, oy);
  }
  return canvas;
}
