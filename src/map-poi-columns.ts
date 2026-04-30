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
import type { LatLng } from './types.js';
import { latLngToCameraRelativeMeters } from './geo.js';

// Vertical extent relative to the camera origin: well below ground and well
// above any plausible landmark.
const COLUMN_Y_MIN_M = -1000;
const COLUMN_Y_MAX_M = 5000;
// Blue is the visual vocabulary for map-POIs; yellow when selected (matches
// the photo handle + anchor marker selected fill).
const COLUMN_COLOR = 0x5080ff;
const COLUMN_COLOR_SELECTED = 0xffff66;
const COLUMN_RENDER_ORDER = 999;

export interface MapPoiColumn {
  readonly anchor: LatLng;
  readonly selected: boolean;
}

export interface MapPoiColumns {
  update(camLoc: LatLng | null, columns: readonly MapPoiColumn[]): void;
}

export interface CreateMapPoiColumnsOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

export function createMapPoiColumns({ scene, requestRender }: CreateMapPoiColumnsOptions): MapPoiColumns {
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

  return {
    update(camLoc, columns) {
      group.clear();
      if (camLoc === null || columns.length === 0) {
        requestRender();
        return;
      }
      for (const c of columns) {
        const { x, z } = latLngToCameraRelativeMeters(c.anchor, camLoc);
        const line = new THREE.Line(lineGeom, c.selected ? materialSelected : material);
        line.position.set(x, 0, z);
        line.renderOrder = COLUMN_RENDER_ORDER;
        line.frustumCulled = false;
        group.add(line);
      }
      requestRender();
    },
  };
}
