// Shared screen-space dot primitive used by the in-photo control-point
// markers (blue / yellow when selected) and other-station markers (green).
// A single Points mesh with vertex colors plus a circular alpha texture.
//
// Always-on-top: depthTest off, renderOrder high — dots stay visible
// through terrain, photo overlays, and the sun marker.

import * as THREE from 'three';
import type { LatLng } from './types.js';
import { makeCanvasTexture } from './canvas-texture.js';
import { latLngToCameraRelativeMeters } from './geo.js';
import { norm2 } from './mathx.js';

const DOT_PIXEL_SIZE = 12;
// Shared render-order for in-photo overlays (dots, observation lines) — high
// enough to sort above terrain and photo overlays in the transparent pass.
export const OVERLAY_RENDER_ORDER = 999;

function makeDotTexture(): THREE.Texture {
  return makeCanvasTexture(32, ctx => {
    ctx.beginPath();
    ctx.arc(16, 16, 13, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
  });
}

export interface Dot {
  readonly anchor: LatLng;
  readonly altitude: number;
  readonly color: THREE.Color;
}

export interface DotLayer {
  update(camLoc: LatLng | null, cameraHeight: number, dots: readonly Dot[]): void;
  setVisible(visible: boolean): void;
}

export interface CreateDotLayerOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

export function createDotLayer({ scene, requestRender }: CreateDotLayerOptions): DotLayer {
  const tex = makeDotTexture();
  const mat = new THREE.PointsMaterial({
    size: DOT_PIXEL_SIZE,
    sizeAttenuation: false,
    map: tex,
    vertexColors: true,
    alphaTest: 0.05,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    fog: false,
  });

  const group = new THREE.Group();
  scene.add(group);

  let points: THREE.Points | null = null;

  function clear(): void {
    if (points === null) return;
    points.geometry.dispose();
    group.remove(points);
    points = null;
  }

  return {
    setVisible(visible) { group.visible = visible; },
    update(camLoc, cameraHeight, dots) {
      clear();
      if (camLoc === null || dots.length === 0) {
        requestRender();
        return;
      }
      const N = dots.length;
      const positions = new Float32Array(N * 3);
      const colors = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const d = dots[i]!;
        const { x, z } = latLngToCameraRelativeMeters(d.anchor, camLoc);
        const y = d.altitude - cameraHeight;
        positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
        colors[i * 3] = d.color.r; colors[i * 3 + 1] = d.color.g; colors[i * 3 + 2] = d.color.b;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      points = new THREE.Points(geom, mat);
      points.renderOrder = OVERLAY_RENDER_ORDER;
      points.frustumCulled = false;
      group.add(points);
      requestRender();
    },
  };
}

// Pick the closest dot in `dots` to an NDC point within `hitRadiusPx` of
// pixel distance on the viewport. NDC alone gives an aspect-ratio-dependent
// hit ellipse; on a 400 px wide phone an NDC radius of 0.01 is only ~2 px,
// which is much smaller than the visible 12 px dot and unhittable by a
// finger. Dots behind the camera are skipped.
const _projected = new THREE.Vector3();
export function findHitDot<T extends { anchor: LatLng; altitude: number }>(
  ndc: { x: number; y: number },
  hitRadiusPx: number,
  viewportWidth: number,
  viewportHeight: number,
  camera: THREE.Camera,
  cameraLocation: LatLng,
  cameraHeight: number,
  dots: readonly T[],
): T | null {
  let best: T | null = null;
  let bestDistPx = hitRadiusPx;
  const halfW = viewportWidth / 2;
  const halfH = viewportHeight / 2;
  for (const dot of dots) {
    const { x, z } = latLngToCameraRelativeMeters(dot.anchor, cameraLocation);
    const y = dot.altitude - cameraHeight;
    _projected.set(x, y, z).project(camera);
    if (_projected.z > 1) continue;
    const dPx = norm2((_projected.x - ndc.x) * halfW, (_projected.y - ndc.y) * halfH);
    if (dPx < bestDistPx) { bestDistPx = dPx; best = dot; }
  }
  return best;
}
