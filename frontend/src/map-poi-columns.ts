// Vertical lines rendered at each map-anchored POI's lat/lng in the 360°
// viewer. A diagnostic aid mirroring the bearing rays drawn for anchored
// POIs in the map view: the user can see at a glance where each anchor
// projects to in 3D space relative to the camera and the photos.
//
// Always-on-top render order so the lines aren't hidden by terrain, photos,
// or the sun marker.
//
// Position is camera-relative meters via the same tangent-plane formula used
// in terrain.ts; rebuild on every camera-location change or POI mutation.
//
// Geometry and material are shared across all columns and never disposed
// (single-instance for the page lifetime).

import * as THREE from 'three';
import type { LatLng, ControlPointView } from './types.js';
import { latLngToCameraRelativeMeters } from './geo.js';

// Vertical extent relative to the camera origin: well below ground and well
// above any plausible landmark. The matcher's hit-test (findHitColumn below)
// projects the same endpoints when computing screen distance.
export const COLUMN_Y_MIN_M = -1000;
export const COLUMN_Y_MAX_M = 5000;
// Blue is the visual vocabulary for map-POIs; yellow when selected (matches
// the photo handle + anchor marker selected fill).
const COLUMN_COLOR = 0x5080ff;
const COLUMN_COLOR_SELECTED = 0xffff66;
const COLUMN_RENDER_ORDER = 999;

export interface ControlPointColumn {
  readonly id: string;
  readonly anchor: LatLng;
  readonly selected: boolean;
}

export interface ControlPointColumns {
  update(camLoc: LatLng | null, columns: readonly ControlPointColumn[]): void;
  // Highlights one column as the matcher target. The hover treatment uses
  // the same yellow material as selection — pre-click feedback that "this
  // is what would be matched if you clicked now."
  setHoveredColumn(id: string | null): void;
  setVisible(visible: boolean): void;
}

export interface CreateControlPointColumnsOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

export function createControlPointColumns({ scene, requestRender }: CreateControlPointColumnsOptions): ControlPointColumns {
  // Single vertical segment along +Y, centered on the origin so each instance
  // can be placed by setting position to the anchor's world coords.
  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute('position', new THREE.Float32BufferAttribute([
    0, COLUMN_Y_MIN_M, 0,
    0, COLUMN_Y_MAX_M, 0,
  ], 3));

  // transparent: true puts the line in the transparent render pass alongside
  // the (transparent) photo overlays. The opaque pass runs first, so without
  // this the lines would render before the photos and get overpainted.
  // renderOrder = 999 then ensures they sort after the photos within that pass.
  const baseMaterialProps = {
    depthTest: false,
    depthWrite: false,
    transparent: true,
    fog: false,
  } as const;
  const material = new THREE.LineBasicMaterial({ color: COLUMN_COLOR, ...baseMaterialProps });
  const materialSelected = new THREE.LineBasicMaterial({ color: COLUMN_COLOR_SELECTED, ...baseMaterialProps });

  const group = new THREE.Group();
  scene.add(group);

  let hoveredId: string | null = null;
  let lastColumns: readonly ControlPointColumn[] = [];
  function pickMaterial(c: ControlPointColumn): THREE.LineBasicMaterial {
    return (c.selected || c.id === hoveredId) ? materialSelected : material;
  }

  return {
    setVisible(visible) { group.visible = visible; },
    update(camLoc, columns) {
      group.clear();
      lastColumns = columns;
      if (camLoc === null || columns.length === 0) {
        requestRender();
        return;
      }
      for (const c of columns) {
        const { x, z } = latLngToCameraRelativeMeters(c.anchor, camLoc);
        const line = new THREE.Line(lineGeom, pickMaterial(c));
        line.position.set(x, 0, z);
        line.renderOrder = COLUMN_RENDER_ORDER;
        line.frustumCulled = false;
        group.add(line);
      }
      requestRender();
    },
    setHoveredColumn(id) {
      if (hoveredId === id) return;
      hoveredId = id;
      // Re-apply materials in place — no need to rebuild geometry.
      for (let i = 0; i < group.children.length; i++) {
        const c = lastColumns[i];
        if (!c) continue;
        (group.children[i] as THREE.Line).material = pickMaterial(c);
      }
      requestRender();
    },
  };
}

const _baseProjected = new THREE.Vector3();
const _topProjected = new THREE.Vector3();
function ndcSegmentDistance(p: { x: number; y: number }, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / lenSq)) : 0;
  return Math.hypot(apx - t * abx, apy - t * aby);
}

// Pick the closest control-point column to an NDC point within `hitRadius`.
// CPs without an estimate (est_lat/est_lng = null) are excluded. Returns
// null when nothing's in range or when both segment endpoints are behind
// the camera (offscreen).
export function findHitColumn(
  ndc: { x: number; y: number },
  hitRadius: number,
  camera: THREE.Camera,
  cameraLocation: LatLng,
  controlPoints: readonly ControlPointView[],
): { controlPointId: string; latlng: LatLng } | null {
  let best: { controlPointId: string; latlng: LatLng } | null = null;
  let bestDist = hitRadius;
  for (const cp of controlPoints) {
    if (cp.estLat === null || cp.estLng === null) continue;
    const latlng = { lat: cp.estLat, lng: cp.estLng };
    const { x, z } = latLngToCameraRelativeMeters(latlng, cameraLocation);
    _baseProjected.set(x, COLUMN_Y_MIN_M, z).project(camera);
    _topProjected.set(x, COLUMN_Y_MAX_M, z).project(camera);
    if (_baseProjected.z > 1 && _topProjected.z > 1) continue;
    const d = ndcSegmentDistance(ndc, _baseProjected, _topProjected);
    if (d < bestDist) { bestDist = d; best = { controlPointId: cp.id, latlng }; }
  }
  return best;
}
