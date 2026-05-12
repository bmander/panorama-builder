// Async terrain build pipeline.
//
// Yields finished ring builds inner→outer for one camera location + curvature
// setting. The orchestrator (terrain/index.ts) hands each yielded ring to the
// scene layer and renders.
//
// Cancellation contract: the consumer must call `abortController.abort()`
// before discontinuing consumption. On abort, the generator stops yielding and
// arranges for any in-flight ring products to self-dispose when their fetches
// resolve — no GPU buffer leaks.

import * as THREE from 'three';
import type { LatLng } from '../types.js';
import {
  buildRingGeometry,
  computeRings,
  ringBounds,
  type RingSpec,
} from './geometry.js';
import {
  fetchCamGroundElev,
  loadRingTiles,
  prefetchRingTiles,
  stitchImageryCanvas,
} from './tiles.js';

export interface TerrainBuildRequest {
  camLoc: LatLng;
  curvatureFactor: number;
}

export interface TerrainRingBuild {
  spec: RingSpec;
  geometry: THREE.BufferGeometry;
  texture: THREE.Texture;
  // Ground elevation at camLoc, sampled from the innermost ring. Identical on
  // every ring of one snapshot; consumers should latch the first.
  camGroundElev: number;
}

interface Built { geometry: THREE.BufferGeometry; texture: THREE.Texture }

function disposeBuilt(b: Built | null): void {
  if (b) { b.geometry.dispose(); b.texture.dispose(); }
}

export async function* buildTerrainSnapshot(
  request: TerrainBuildRequest,
  signal: AbortSignal,
): AsyncIterable<TerrainRingBuild> {
  // Wrap aborted check in a closure so TS doesn't narrow signal.aborted
  // (a readonly boolean) to false after the first check.
  const isAborted = (): boolean => signal.aborted;
  if (isAborted()) return;

  // computeRings() returns innermost first (z=14 → z=8), which is the same
  // order display proceeds in: the camera's immediate surroundings land
  // first, then progressively wider rings fill in toward the horizon.
  const rings = computeRings();
  const innermost = rings[0]!;

  // Kick the elevation-anchor fetch off first so it sits at the head of the
  // browser's tile queue — every subsequent ring build needs it.
  const camGroundElevPromise = fetchCamGroundElev(request.camLoc, innermost);
  for (const spec of rings) prefetchRingTiles(request.camLoc, spec);

  const camGroundElev = await camGroundElevPromise;
  if (isAborted()) return;

  // Each ring's hole is the next-finer ring's outer rectangle — pure function
  // of camLoc + spec, no tile data needed. The innermost ring (index 0) has
  // no finer neighbor and so no hole.
  const holes = rings.map((_, i) => {
    const innerSpec = rings[i - 1];
    return innerSpec ? ringBounds(request.camLoc, innerSpec) : undefined;
  });

  // Build every ring concurrently. Each disposes its own products on
  // cancellation; the consume loop below pulls them strictly inner-first.
  const buildPromises = rings.map(async (spec, i): Promise<Built | null> => {
    const { demTiles, imageryTiles } = await loadRingTiles(request.camLoc, spec);
    if (isAborted()) return null;
    const geom = buildRingGeometry(request.camLoc, spec, request.curvatureFactor, demTiles, camGroundElev, holes[i]);
    const canvas = stitchImageryCanvas(request.camLoc, spec, imageryTiles);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(geom.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(geom.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(geom.indices, 1));
    // Normals required for Lambert lighting; cheap enough to always compute so
    // wireframe→shaded swaps don't need a rebuild.
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    // The canvas is drawn with north at y=0 already, so disable the default
    // flip so UV.y = j/(ny-1) lines up directly: j=0 (north vertex) → UV.y=0
    // → canvas top → north tile.
    texture.flipY = false;

    if (isAborted()) {
      geometry.dispose();
      texture.dispose();
      return null;
    }
    return { geometry, texture };
  });

  let nextIndex = 0;
  try {
    for (; nextIndex < buildPromises.length; nextIndex++) {
      const result = await buildPromises[nextIndex]!;
      if (isAborted()) {
        disposeBuilt(result);
        return;
      }
      if (!result) continue;
      yield {
        spec: rings[nextIndex]!,
        geometry: result.geometry,
        texture: result.texture,
        camGroundElev,
      };
    }
  } finally {
    // Any promises we never awaited (consumer aborted or broke early) will
    // still resolve in the background; self-dispose their products.
    for (let j = nextIndex + 1; j < buildPromises.length; j++) {
      void buildPromises[j]!.then(disposeBuilt);
    }
  }
}
