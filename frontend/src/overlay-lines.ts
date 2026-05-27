// Always-on-top line primitives shared by the overlay modules
// (null-cp-rays, map-poi-columns, station-cones). Each builder applies the
// canonical render-order + frustum-cull flags so they match the dot layer.

import * as THREE from 'three';
import { OVERLAY_RENDER_ORDER } from './dot-layer.js';
import { norm2 } from './mathx.js';

// LineBasicMaterial flags every overlay line shares: depth test off so lines
// layer on top of terrain / photos, transparent so they participate in the
// same render pass, fog off so atmosphere doesn't dim them.
export const OVERLAY_LINE_BASE_PROPS = {
  depthTest: false, depthWrite: false, transparent: true, fog: false,
} as const;

export function makeOverlayLineMaterial(color: THREE.ColorRepresentation): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color, ...OVERLAY_LINE_BASE_PROPS });
}

export function makeOverlayLineSegments(
  positions: Float32Array, mat: THREE.LineBasicMaterial,
): THREE.LineSegments {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const segs = new THREE.LineSegments(geom, mat);
  segs.renderOrder = OVERLAY_RENDER_ORDER;
  segs.frustumCulled = false;
  return segs;
}

export function makeOverlayLine(
  positions: readonly number[], mat: THREE.LineBasicMaterial,
): THREE.Line {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const line = new THREE.Line(geom, mat);
  line.renderOrder = OVERLAY_RENDER_ORDER;
  line.frustumCulled = false;
  return line;
}

// Disposes BufferGeometry on every Line / LineSegments child, then clears
// the group. LineSegments extends Line in three, so the instanceof check
// catches both.
export function clearLineGroup(group: THREE.Group): void {
  for (const child of group.children) {
    if (child instanceof THREE.Line) {
      (child.geometry as THREE.BufferGeometry).dispose();
    }
  }
  group.clear();
}

// Distance from `ndc` to the line segment a→b (both in viewer-local world
// coords) projected through `camera`. When `clamp` is true the projection
// parameter is bounded to [0, 1] (finite segment); otherwise the distance is
// to the infinite line through a, b. Returns Infinity when either endpoint
// sits behind the near plane (project() flips sign there and the projected
// line stops representing the visible segment).
//
// `halfW`/`halfH` scale the projected NDC coords to pixel offsets from the
// viewport center before measuring, so the result is a pixel distance — pass
// viewportWidth/2, viewportHeight/2 for a screen-space hit radius. Left at the
// 1 defaults the distance stays in (aspect-dependent) NDC units.
const _segA = new THREE.Vector3();
const _segB = new THREE.Vector3();
export function ndcDistToProjectedSegment(
  ndc: { x: number; y: number },
  a: THREE.Vector3, b: THREE.Vector3,
  camera: THREE.Camera,
  clamp: boolean,
  halfW = 1,
  halfH = 1,
): number {
  _segA.copy(a).project(camera);
  _segB.copy(b).project(camera);
  if (_segA.z > 1 || _segB.z > 1) return Infinity;
  const ax = _segA.x * halfW, ay = _segA.y * halfH;
  const bx = _segB.x * halfW, by = _segB.y * halfH;
  const px = ndc.x * halfW, py = ndc.y * halfH;
  const dx = bx - ax;
  const dy = by - ay;
  const len = norm2(dx, dy);
  if (len === 0) return Infinity;
  if (!clamp) {
    return Math.abs(dx * (py - ay) - dy * (px - ax)) / len;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (len * len)));
  return norm2(px - (ax + t * dx), py - (ay + t * dy));
}
