// Per-control-point markers + observation lines rendered in the 360° viewer.
//
// Each control point with an estimated lat/lng/alt gets a small sphere at its
// 3D position (camera-relative meters via latLngToCameraRelativeMeters; world
// y = est_alt − cameraHeight). Each linked image-measurement (a POI on a photo
// overlay) gets a line from the marker to the POI's world position — a visible
// "residual": short = pose fits the CP well, long = poor fit.
//
// Always-on-top (depthTest off, renderOrder high) so markers and lines aren't
// hidden by terrain, photos, or the sun marker.
//
// (Filename retained from the original "map-poi columns" implementation; the
// columns were replaced with point markers + lines.)

import * as THREE from 'three';
import type { LatLng, ControlPointView } from './types.js';
import { makeCanvasTexture } from './canvas-texture.js';
import { latLngToCameraRelativeMeters } from './geo.js';
import { norm2 } from './mathx.js';

const MARKER_COLOR = 0x5080ff;
const MARKER_COLOR_SELECTED = 0xffff66;
// Marker is a screen-space disc, not a world-space sphere — keeps distant CPs
// visible and clickable. gl_PointSize is in pixels with sizeAttenuation off.
const MARKER_PIXEL_SIZE = 12;
const MARKER_RENDER_ORDER = 999;

function makeMarkerTexture(): THREE.Texture {
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

export interface ControlPointMarker {
  readonly id: string;
  readonly anchor: LatLng;
  readonly altitude: number;
  readonly selected: boolean;
  // Scene-graph handles for image measurements linked to this CP. World
  // positions are resolved during update() via getWorldPosition().
  readonly observations: readonly THREE.Object3D[];
}

export interface ControlPointMarkers {
  // markers: per-CP positions + linked observation handles. cameraHeight is
  // the terrain.getCameraHeight() value used to translate est_alt into
  // viewer-space y (the terrain group is shifted by −cameraHeight, so a CP
  // at est_alt sits at viewer y = est_alt − cameraHeight).
  update(camLoc: LatLng | null, cameraHeight: number, markers: readonly ControlPointMarker[]): void;
  setHoveredMarker(id: string | null): void;
  setVisible(visible: boolean): void;
}

export interface CreateControlPointMarkersOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

// Backwards-compat aliases. The exports were renamed when the columns became
// point markers, but main.ts kept the old names — re-exported here so the
// import surface stays small.
export type ControlPointColumn = ControlPointMarker;
export type ControlPointColumns = ControlPointMarkers;

export function createControlPointColumns(opts: CreateControlPointMarkersOptions): ControlPointMarkers {
  const { scene, requestRender } = opts;

  // transparent: true puts the markers in the same render pass as the
  // (transparent) photo overlays; renderOrder=999 then sorts them on top.
  const baseMaterialProps = {
    depthTest: false,
    depthWrite: false,
    transparent: true,
    fog: false,
  } as const;
  const markerTex = makeMarkerTexture();
  const markerMat = new THREE.PointsMaterial({
    size: MARKER_PIXEL_SIZE,
    sizeAttenuation: false,
    map: markerTex,
    vertexColors: true,
    alphaTest: 0.05,
    ...baseMaterialProps,
  });
  const lineMat = new THREE.LineBasicMaterial({ color: MARKER_COLOR, ...baseMaterialProps });
  const lineMatSel = new THREE.LineBasicMaterial({ color: MARKER_COLOR_SELECTED, ...baseMaterialProps });
  const colorDefault = new THREE.Color(MARKER_COLOR);
  const colorSelected = new THREE.Color(MARKER_COLOR_SELECTED);

  const group = new THREE.Group();
  scene.add(group);

  let hoveredId: string | null = null;
  let lastMarkers: readonly ControlPointMarker[] = [];
  let lastCamLoc: LatLng | null = null;
  let lastCameraHeight = 0;

  function isHighlighted(m: ControlPointMarker): boolean {
    return m.selected || m.id === hoveredId;
  }

  function clearChildren(): void {
    for (const child of group.children) {
      // All geometries are per-rebuild now (Points + Lines); shared material
      // is disposed at module teardown only.
      if (child instanceof THREE.Line || child instanceof THREE.Points) {
        (child.geometry as THREE.BufferGeometry).dispose();
      }
    }
    group.clear();
  }

  const scratch = new THREE.Vector3();

  function rebuild(): void {
    clearChildren();
    if (lastCamLoc === null || lastMarkers.length === 0) {
      requestRender();
      return;
    }

    const N = lastMarkers.length;
    const positions = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const m = lastMarkers[i]!;
      const { x, z } = latLngToCameraRelativeMeters(m.anchor, lastCamLoc);
      const y = m.altitude - lastCameraHeight;
      positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
      const c = isHighlighted(m) ? colorSelected : colorDefault;
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    const pointsGeom = new THREE.BufferGeometry();
    pointsGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    pointsGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const points = new THREE.Points(pointsGeom, markerMat);
    points.renderOrder = MARKER_RENDER_ORDER;
    points.frustumCulled = false;
    group.add(points);

    for (const m of lastMarkers) {
      const { x, z } = latLngToCameraRelativeMeters(m.anchor, lastCamLoc);
      const y = m.altitude - lastCameraHeight;
      const lineMaterial = isHighlighted(m) ? lineMatSel : lineMat;
      for (const poi of m.observations) {
        poi.getWorldPosition(scratch);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute([
          x, y, z,
          scratch.x, scratch.y, scratch.z,
        ], 3));
        const line = new THREE.Line(geom, lineMaterial);
        line.renderOrder = MARKER_RENDER_ORDER;
        line.frustumCulled = false;
        group.add(line);
      }
    }
    requestRender();
  }

  return {
    setVisible(visible) { group.visible = visible; },
    update(camLoc, cameraHeight, markers) {
      lastCamLoc = camLoc;
      lastCameraHeight = cameraHeight;
      lastMarkers = markers;
      rebuild();
    },
    setHoveredMarker(id) {
      if (hoveredId === id) return;
      hoveredId = id;
      // Hover changes are infrequent (only on pointermove transitions across
      // a marker); a full rebuild costs O(markers + observations) which is
      // <100 on typical scenes.
      rebuild();
    },
  };
}

// Pick the closest control-point marker to an NDC point within `hitRadius`.
// CPs without an estimate (est_lat/est_lng = null) are excluded by the caller
// (getStationObservedControlPoints already filters them out). Returns null
// when nothing is in range or when the marker is behind the camera.
const _projected = new THREE.Vector3();
export function findHitColumn(
  ndc: { x: number; y: number },
  hitRadius: number,
  camera: THREE.Camera,
  cameraLocation: LatLng,
  cameraHeight: number,
  controlPoints: readonly ControlPointView[],
): { controlPointId: string; latlng: LatLng } | null {
  let best: { controlPointId: string; latlng: LatLng } | null = null;
  let bestDist = hitRadius;
  for (const cp of controlPoints) {
    if (cp.estLat === null || cp.estLng === null) continue;
    const latlng = { lat: cp.estLat, lng: cp.estLng };
    const { x, z } = latLngToCameraRelativeMeters(latlng, cameraLocation);
    const y = cp.estAlt - cameraHeight;
    _projected.set(x, y, z).project(camera);
    if (_projected.z > 1) continue; // behind camera
    const d = norm2(_projected.x - ndc.x, _projected.y - ndc.y);
    if (d < bestDist) { bestDist = d; best = { controlPointId: cp.id, latlng }; }
  }
  return best;
}
