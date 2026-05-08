// Always-on-top line primitives shared by the overlay modules
// (null-cp-rays, map-poi-columns, station-cones). Each builder applies the
// canonical render-order + frustum-cull flags so they match the dot layer.

import * as THREE from 'three';
import { OVERLAY_RENDER_ORDER } from './dot-layer.js';

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
