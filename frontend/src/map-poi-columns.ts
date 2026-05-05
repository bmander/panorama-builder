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
import { latLngToCameraRelativeMeters } from './geo.js';
import { createDotLayer, findHitDot, OVERLAY_RENDER_ORDER } from './dot-layer.js';
import type { Dot } from './dot-layer.js';

const MARKER_COLOR = 0x5080ff;
const MARKER_COLOR_SELECTED = 0xffff66;

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

  const dots = createDotLayer({ scene, requestRender });

  // transparent: true puts the lines in the same render pass as the
  // (transparent) photo overlays; renderOrder sorts them on top.
  const baseLineProps = {
    depthTest: false, depthWrite: false, transparent: true, fog: false,
  } as const;
  const lineMat = new THREE.LineBasicMaterial({ color: MARKER_COLOR, ...baseLineProps });
  const lineMatSel = new THREE.LineBasicMaterial({ color: MARKER_COLOR_SELECTED, ...baseLineProps });
  const colorDefault = new THREE.Color(MARKER_COLOR);
  const colorSelected = new THREE.Color(MARKER_COLOR_SELECTED);

  const lineGroup = new THREE.Group();
  scene.add(lineGroup);

  let hoveredId: string | null = null;
  let lastMarkers: readonly ControlPointMarker[] = [];
  let lastCamLoc: LatLng | null = null;
  let lastCameraHeight = 0;

  function isHighlighted(m: ControlPointMarker): boolean {
    return m.selected || m.id === hoveredId;
  }

  function clearLines(): void {
    for (const child of lineGroup.children) {
      if (child instanceof THREE.Line) {
        (child.geometry as THREE.BufferGeometry).dispose();
      }
    }
    lineGroup.clear();
  }

  const scratch = new THREE.Vector3();

  function rebuild(): void {
    clearLines();
    if (lastCamLoc === null || lastMarkers.length === 0) {
      dots.update(null, 0, []);
      requestRender();
      return;
    }

    const dotList: Dot[] = lastMarkers.map(m => ({
      anchor: m.anchor,
      altitude: m.altitude,
      color: isHighlighted(m) ? colorSelected : colorDefault,
    }));
    dots.update(lastCamLoc, lastCameraHeight, dotList);

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
        line.renderOrder = OVERLAY_RENDER_ORDER;
        line.frustumCulled = false;
        lineGroup.add(line);
      }
    }
    requestRender();
  }

  return {
    setVisible(visible) { dots.setVisible(visible); lineGroup.visible = visible; },
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
export function findHitColumn(
  ndc: { x: number; y: number },
  hitRadius: number,
  camera: THREE.Camera,
  cameraLocation: LatLng,
  cameraHeight: number,
  controlPoints: readonly ControlPointView[],
): { controlPointId: string; latlng: LatLng } | null {
  const dots = controlPoints
    .filter((cp): cp is ControlPointView & { estLat: number; estLng: number } =>
      cp.estLat !== null && cp.estLng !== null)
    .map(cp => ({ id: cp.id, anchor: { lat: cp.estLat, lng: cp.estLng }, altitude: cp.estAlt }));
  const hit = findHitDot(ndc, hitRadius, camera, cameraLocation, cameraHeight, dots);
  return hit ? { controlPointId: hit.id, latlng: hit.anchor } : null;
}
