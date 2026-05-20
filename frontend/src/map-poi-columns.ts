// Per-control-point markers + observation lines rendered in the 360° viewer.
//
// Each control point with an estimated lat/lng/alt gets a small sphere at its
// 3D position (camera-relative meters via latLngToCameraRelativeMeters; world
// y = est_alt − cameraMSL). Each linked image-measurement (a POI on a photo
// overlay) gets a line from the marker to the POI's world position — a visible
// "residual": short = pose fits the CP well, long = poor fit.
//
// CPs whose est_alt is null ("elevation unknown") are drawn as vertical lines
// at (lat,lng) instead of dots — a column reaching far above and below the
// viewer reminds you that the location is map-anchored but height-free.
// Observation residual lines aren't drawn for these (no defined endpoint).
//
// Always-on-top (depthTest off, renderOrder high) so markers and lines aren't
// hidden by terrain, photos, or the sun marker.

import * as THREE from 'three';
import type { LatLng, ControlPointView } from './types.js';
import type { ApiCpObservationStatus } from './api.js';
import { curvatureDrop, subscribeCurvatureChange } from './curvature.js';
import { latLngToCameraRelativeMeters } from './geo.js';
import { createDotLayer } from './dot-layer.js';
import type { Dot } from './dot-layer.js';
import {
  clearLineGroup, makeOverlayLine, ndcDistToProjectedSegment,
  OVERLAY_LINE_BASE_PROPS,
} from './overlay-lines.js';
import { norm2 } from './mathx.js';

const MARKER_COLOR = 0x5080ff;
const MARKER_COLOR_SELECTED = 0xffff66;
const MARKER_COLOR_ABSENT = 0xff7878;     // light red
const MARKER_COLOR_OBSCURED = 0x5e9a9a;   // desaturated teal

// Half-height of the vertical line for a null-altitude CP, in viewer-relative
// meters. The viewer camera's far plane is 1e6, so 1e4 is well inside it and
// looks infinite at any practical FOV.
const COLUMN_HALF_HEIGHT = 1e4;

// Half-height used for screen-space hit testing of the vertical line. Smaller
// than the rendered span: we just need two points reliably in front of the
// camera to compute the projected line direction.
const COLUMN_HIT_HALF_HEIGHT = 100;

export interface ControlPointMarker {
  readonly id: string;
  readonly anchor: LatLng;
  // null altitude → render as a vertical line at (lat,lng) instead of a dot.
  readonly altitude: number | null;
  readonly selected: boolean;
  // Per-station visibility status; tints the marker (absent → red,
  // obscured → teal).
  readonly status: ApiCpObservationStatus | null;
  // Scene-graph handles for image measurements linked to this CP. World
  // positions are resolved during update() via getWorldPosition(). Ignored
  // when altitude is null (no defined endpoint to draw a residual to).
  readonly observations: readonly THREE.Object3D[];
}

export interface ControlPointMarkers {
  // markers: per-CP positions + linked observation handles. cameraMSL comes
  // from the shared world-camera pose; both it and est_alt are metres above
  // mean sea level, so a CP at est_alt sits at viewer y = est_alt − cameraMSL.
  update(camLoc: LatLng | null, cameraMSL: number, markers: readonly ControlPointMarker[]): void;
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

  // Observed CPs paint as filled dots; CPs visible only because "show all"
  // is on (zero observations from this station) paint as outline-only rings
  // in the same blue, so observed vs unobserved is readable at a glance.
  const filledDots = createDotLayer({ scene, requestRender });
  const outlineDots = createDotLayer({ scene, requestRender, style: 'outline' });

  const lineMat = new THREE.LineBasicMaterial({ color: MARKER_COLOR, ...OVERLAY_LINE_BASE_PROPS });
  const lineMatSel = new THREE.LineBasicMaterial({ color: MARKER_COLOR_SELECTED, ...OVERLAY_LINE_BASE_PROPS });
  const colorDefault = new THREE.Color(MARKER_COLOR);
  const colorSelected = new THREE.Color(MARKER_COLOR_SELECTED);
  const colorAbsent = new THREE.Color(MARKER_COLOR_ABSENT);
  const colorObscured = new THREE.Color(MARKER_COLOR_OBSCURED);

  function statusColor(status: ApiCpObservationStatus | null): THREE.Color {
    if (status === 'absent') return colorAbsent;
    if (status === 'obscured') return colorObscured;
    return colorDefault;
  }

  const lineGroup = new THREE.Group();
  scene.add(lineGroup);

  let hoveredId: string | null = null;
  let lastMarkers: readonly ControlPointMarker[] = [];
  let lastCamLoc: LatLng | null = null;
  let lastCameraMSL = 0;

  function isHighlighted(m: ControlPointMarker): boolean {
    return m.selected || m.id === hoveredId;
  }

  const scratch = new THREE.Vector3();

  function rebuild(): void {
    clearLineGroup(lineGroup);
    if (lastCamLoc === null || lastMarkers.length === 0) {
      filledDots.update(null, 0, []);
      outlineDots.update(null, 0, []);
      requestRender();
      return;
    }

    const filledList: Dot[] = [];
    const outlineList: Dot[] = [];
    for (const m of lastMarkers) {
      const highlighted = isHighlighted(m);
      const color = highlighted ? colorSelected : statusColor(m.status);
      const lineMaterial = highlighted ? lineMatSel : lineMat;
      const { x, z } = latLngToCameraRelativeMeters(m.anchor, lastCamLoc);
      const drop = curvatureDrop(x * x + z * z);
      if (m.altitude === null) {
        addLine(lineMaterial, x, -COLUMN_HALF_HEIGHT - drop, z, x, COLUMN_HALF_HEIGHT - drop, z);
        continue;
      }
      const dot = { anchor: m.anchor, altitude: m.altitude, color };
      if (m.observations.length > 0) filledList.push(dot);
      else outlineList.push(dot);
      // Residual lines stay hidden until the CP is selected — they're
      // a focused debugging cue, not steady ambient clutter.
      if (!m.selected) continue;
      const y = m.altitude - lastCameraMSL - drop;
      for (const poi of m.observations) {
        poi.getWorldPosition(scratch);
        addLine(lineMaterial, x, y, z, scratch.x, scratch.y, scratch.z);
      }
    }
    filledDots.update(lastCamLoc, lastCameraMSL, filledList);
    outlineDots.update(lastCamLoc, lastCameraMSL, outlineList);
    requestRender();
  }

  function addLine(
    mat: THREE.LineBasicMaterial,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
  ): void {
    lineGroup.add(makeOverlayLine([ax, ay, az, bx, by, bz], mat));
  }

  // Dots are baked by dot-layer, which subscribes independently.
  subscribeCurvatureChange(rebuild);

  return {
    setVisible(visible) {
      filledDots.setVisible(visible);
      outlineDots.setVisible(visible);
      lineGroup.visible = visible;
    },
    update(camLoc, cameraMSL, markers) {
      lastCamLoc = camLoc;
      lastCameraMSL = cameraMSL;
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

const _proj = new THREE.Vector3();
const _colBot = new THREE.Vector3();
const _colTop = new THREE.Vector3();

// Pick the closest control-point — either a dot at (lat,lng,alt) or a vertical
// column at (lat,lng) with unknown altitude — to an NDC point within
// `hitRadius`. CPs with NULL est_lat/est_lng are excluded. Returns null when
// nothing is in range.
export function findHitColumn(
  ndc: { x: number; y: number },
  hitRadius: number,
  camera: THREE.Camera,
  cameraLocation: LatLng,
  cameraMSL: number,
  controlPoints: readonly ControlPointView[],
): { controlPointId: string; latlng: LatLng } | null {
  let bestDist = hitRadius;
  let best: { controlPointId: string; latlng: LatLng } | null = null;
  for (const cp of controlPoints) {
    if (cp.estLat === null || cp.estLng === null) continue;
    const { x, z } = latLngToCameraRelativeMeters({ lat: cp.estLat, lng: cp.estLng }, cameraLocation);
    const drop = curvatureDrop(x * x + z * z);
    let dist: number;
    if (cp.estAlt !== null) {
      const y = cp.estAlt - cameraMSL - drop;
      _proj.set(x, y, z).project(camera);
      if (_proj.z > 1) continue;
      dist = norm2(_proj.x - ndc.x, _proj.y - ndc.y);
    } else {
      _colBot.set(x, -COLUMN_HIT_HALF_HEIGHT - drop, z);
      _colTop.set(x, COLUMN_HIT_HALF_HEIGHT - drop, z);
      dist = ndcDistToProjectedSegment(ndc, _colBot, _colTop, camera, false);
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = { controlPointId: cp.id, latlng: { lat: cp.estLat, lng: cp.estLng } };
    }
  }
  return best;
}
