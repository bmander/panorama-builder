// Scene assembly: every Three.js renderer + the baker + hud + worldCamera
// the station route composes. Owns the renderer construction order, the
// baker's setVisualsVisible cascade, and the per-pose fan-out. Stateless
// w.r.t. station data — applyPose receives a typed snapshot from the
// caller so this module has no opinion about where the data lives.

import * as THREE from 'three';
import { createViewer, DEFAULT_FOV } from '../viewer.js';
import type { Viewer } from '../viewer.js';
import { createOverlayManager } from '../overlay.js';
import type { OverlayManager } from '../overlay.js';
import { createBaker } from '../bake.js';
import type { Baker } from '../bake.js';
import { createHud } from '../ui.js';
import type { Hud } from '../ui.js';
import { createTerrainView } from '../terrain/index.js';
import type { TerrainView } from '../terrain/index.js';
import { createSunMarker } from '../sun-marker.js';
import type { SunMarker } from '../sun-marker.js';
import { createSky } from '../sky.js';
import type { Sky } from '../sky.js';
import { createControlPointColumns } from '../map-poi-columns.js';
import type { ControlPointColumn, ControlPointMarkers } from '../map-poi-columns.js';
import { createObservationRays } from '../observation-rays.js';
import type { ObservationRay, ObservationRays } from '../observation-rays.js';
import { createCPConstraintLines } from '../cp-constraint-lines.js';
import type { CPConstraintLines } from '../cp-constraint-lines.js';
import { createCPSurfaces } from '../cp-surfaces.js';
import type { CPSurfaces } from '../cp-surfaces.js';
import { createStationMarkers } from '../station-markers.js';
import type { StationMarker, StationMarkers } from '../station-markers.js';
import { createStationCones } from '../station-cones.js';
import type { StationCone, StationCones } from '../station-cones.js';
import { createPhotoPreviews } from '../photo-previews.js';
import type { PhotoPreviews } from '../photo-previews.js';
import { createDotLayer } from '../dot-layer.js';
import type { Dot, DotLayer } from '../dot-layer.js';
import { createWorldCamera } from '../world-camera.js';
import type { WorldCamera } from '../world-camera.js';
import { makeOverlayLine, makeOverlayLineMaterial } from '../overlay-lines.js';
import { latLngToCameraRelativeMeters } from '../geo.js';
import { controlPointVertex, latLngAltVertex } from '../camera-anchored.js';
import { degToRad } from '../mathx.js';
import { meshMat, overlayData } from '../types.js';
import type { CPConstraintView, CPSurfaceView, ControlPointView, LatLng } from '../types.js';
import type { ShadowLocation } from '../sundial-modal.js';

const SUNDIAL_LINE_COLOR_HEX = 0xffaa44;

// Snapshot fed into applyPose on every pose change. Field types mirror what
// the renderers consume; reference equality on the array fields keeps each
// renderer's fast path alive (no rebuild when the underlying list hasn't
// changed).
export interface PoseRenderSnapshot {
  readonly cpMarkers: readonly ControlPointColumn[];
  readonly visibleCps: readonly ControlPointView[];
  readonly observationRays: readonly ObservationRay[];
  readonly otherStations: readonly StationMarker[];
  readonly otherCameras: readonly StationCone[];
  readonly selectedStationId: string | null;
  readonly cpConstraints: readonly CPConstraintView[];
  readonly selectedConstraintId: string | null;
  readonly multiSelectedConstraintIds: ReadonlySet<string>;
  readonly cpSurfaces: readonly CPSurfaceView[];
  readonly selectedSurfaceId: string | null;
  readonly sundialMarkerDots: readonly Dot[];
  readonly sundialGnomonCpId: string | null;
  readonly sundialShadow: ShadowLocation | null;
}

export interface StationScene {
  readonly viewer: Viewer;
  readonly overlays: OverlayManager;
  readonly worldCamera: WorldCamera;
  readonly terrain: TerrainView;
  readonly sky: Sky;
  readonly sunMarker: SunMarker;
  readonly cpColumns: ControlPointMarkers;
  readonly stationDots: StationMarkers;
  readonly stationCones: StationCones;
  readonly observationRays: ObservationRays;
  readonly cpConstraintLines: CPConstraintLines;
  readonly cpSurfacesRenderer: CPSurfaces;
  readonly photoPreviews: PhotoPreviews;
  readonly baker: Baker;
  readonly hud: Hud;
  // Sundial visuals: shadow-point dot layer + camera-anchored line. The line
  // is mutated in place by applyPose; sundialMarkerDots arrive via the
  // snapshot.
  readonly sundialMarker: DotLayer;
  readonly sundialLine: THREE.Line;
  readonly sundialLinePos: THREE.BufferAttribute;
  // Constraint-drag preview line. Driven externally (input handler mutates
  // previewPositions and flips previewLine.visible directly).
  readonly previewLine: THREE.Line;
  readonly previewPositions: THREE.BufferAttribute;
  applyPose(snapshot: PoseRenderSnapshot): void;
  pushTerrainFromPose(): void;
}

export interface CreateStationSceneOptions {
  readonly container: HTMLElement;
}

export function createStationScene(opts: CreateStationSceneOptions): StationScene {
  const { container } = opts;

  const halfFovTan = (fovDeg: number): number => Math.tan(degToRad(fovDeg) / 2);
  const POI_FOV_REFERENCE_TAN = halfFovTan(DEFAULT_FOV);

  const viewer = createViewer({
    container,
    onFovChange: fov => {
      overlays.measurements.setFovScale(halfFovTan(fov) / POI_FOV_REFERENCE_TAN);
    },
  });

  // Callbacks are attached by wiring once sync, baker, and the refreshers
  // exist — see the construction-order note in overlay.ts.
  const overlays = createOverlayManager({
    overlaysGroup: viewer.overlaysGroup,
    getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
  });

  const sky = createSky({
    scene: viewer.scene,
    renderer: viewer.renderer,
    requestRender: () => { viewer.requestRender(); },
  });
  const terrain = createTerrainView({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  const sunMarker = createSunMarker({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  const cpColumns = createControlPointColumns({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  const stationDots = createStationMarkers({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  const observationRays = createObservationRays({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  const stationCones = createStationCones({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  const photoPreviews = createPhotoPreviews({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
    getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
  });
  const cpConstraintLines = createCPConstraintLines({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  const cpSurfacesRenderer = createCPSurfaces({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });

  // Constraint-drag preview line. Updated in place by the input handler so
  // the per-pointermove update doesn't stomp the persisted constraint lines.
  const previewMat = makeOverlayLineMaterial(0xffffff);
  const previewLine = makeOverlayLine([0, 0, 0, 0, 0, 0], previewMat);
  previewLine.visible = false;
  viewer.scene.add(previewLine);
  const previewPositions = previewLine.geometry.getAttribute('position') as THREE.BufferAttribute;

  // Sundial visuals: dot layer for shadow point + line from gnomon CP to
  // shadow. Both camera-anchored; the line gets its endpoints recomputed by
  // applyPose's updateSundialLine (a fast two-vertex transform per frame).
  const sundialMarker = createDotLayer({
    scene: viewer.scene,
    requestRender: () => { viewer.requestRender(); },
  });
  const sundialLineMat = makeOverlayLineMaterial(SUNDIAL_LINE_COLOR_HEX);
  const sundialLine = makeOverlayLine([0, 0, 0, 0, 0, 0], sundialLineMat);
  sundialLine.visible = false;
  viewer.scene.add(sundialLine);
  const sundialLinePos = sundialLine.geometry.getAttribute('position') as THREE.BufferAttribute;

  const baker = createBaker({
    renderer: viewer.renderer,
    scene: viewer.scene,
    setVisualsVisible: visible => {
      overlays.setVisualsVisible(visible);
      cpColumns.setVisible(visible);
      stationDots.setVisible(visible);
      observationRays.setVisible(visible);
      stationCones.setVisible(visible);
      cpConstraintLines.setVisible(visible);
      cpSurfacesRenderer.setVisible(visible);
      sundialMarker.setVisible(visible);
      if (!visible) sundialLine.visible = false;
      photoPreviews.setBakeHidden(!visible);
      if (!visible) previewLine.visible = false;
      // Suppress sky.regenProbe during the bake's CubeCamera render (it
      // would compete for the renderer's render-target state). The sky
      // quad in the main scene still renders into each cube face.
      if (visible) sky.endBake(); else sky.beginBake();
    },
  });

  const worldCamera = createWorldCamera();

  const hud = createHud(() => {
    const { azimuth, altitude } = viewer.getAzAlt();
    const sel = overlays.photos.getSelected();
    let selectedRadPerPixel: number | null = null;
    if (sel) {
      const data = overlayData(sel);
      const img = meshMat(data.body).map?.image as
        { naturalWidth?: number; width?: number } | null | undefined;
      const px = img?.naturalWidth ?? img?.width ?? 0;
      if (px > 0) selectedRadPerPixel = data.sizeRad / px;
    }
    return {
      azimuth, altitude,
      fov: viewer.camera.fov,
      selectedSizeRad: sel ? overlayData(sel).sizeRad : null,
      selectedRadPerPixel,
      cameraMSL: worldCamera.getPose().altitudeMSL,
      cameraHeightAboveGround: terrain.getCameraHeightAboveGround(),
    };
  });

  // Memo of the inputs that produced the current sundial line geometry.
  // Same-ref applyPose calls (camera + picks unchanged) become no-ops so we
  // skip the BufferAttribute upload entirely.
  let lastSundialCamLoc: LatLng | null = null;
  let lastSundialCameraMSL = NaN;
  let lastSundialCpId: string | null = null;
  let lastSundialShadow: ShadowLocation | null = null;
  function updateSundialLine(
    camLoc: LatLng | null,
    cameraMSL: number,
    cpId: string | null,
    shadow: ShadowLocation | null,
  ): void {
    if (camLoc === lastSundialCamLoc && cameraMSL === lastSundialCameraMSL
      && cpId === lastSundialCpId && shadow === lastSundialShadow) return;
    lastSundialCamLoc = camLoc;
    lastSundialCameraMSL = cameraMSL;
    lastSundialCpId = cpId;
    lastSundialShadow = shadow;
    if (camLoc === null || cpId === null || shadow === null) {
      sundialLine.visible = false;
      return;
    }
    const cp = overlays.controlPoints.getById(cpId);
    const g = cp ? controlPointVertex(cp, camLoc, cameraMSL) : null;
    if (g === null) {
      sundialLine.visible = false;
      return;
    }
    const s = latLngAltVertex(shadow.latlng, shadow.altitude, camLoc, cameraMSL);
    const arr = sundialLinePos.array as Float32Array;
    arr[0] = g.x; arr[1] = g.y; arr[2] = g.z;
    arr[3] = s.x; arr[4] = s.y; arr[5] = s.z;
    sundialLinePos.needsUpdate = true;
    sundialLine.visible = true;
  }

  // Photo overlays are rendered as a sphere around the camera at scene
  // origin, so by default they follow the camera. While the camera is
  // detached from the station (shift-wheel has displaced it), translate
  // overlaysGroup so the photos stay at the station's true location and
  // the user can fly past or around them.
  function updateOverlaysGroupOffset(): void {
    const pose = worldCamera.getPose();
    if (!pose.stationAnchor || !pose.location || pose.stationAltitudeMSL === null
        || (pose.location.lat === pose.stationAnchor.lat && pose.location.lng === pose.stationAnchor.lng)) {
      viewer.overlaysGroup.position.set(0, 0, 0);
      return;
    }
    const offset = latLngToCameraRelativeMeters(pose.stationAnchor, pose.location);
    viewer.overlaysGroup.position.set(offset.x, pose.stationAltitudeMSL - pose.altitudeMSL, offset.z);
  }

  function applyPose(snapshot: PoseRenderSnapshot): void {
    const pose = worldCamera.getPose();
    cpColumns.update(pose.location, pose.altitudeMSL, snapshot.cpMarkers);
    stationDots.update(pose.location, pose.altitudeMSL, snapshot.otherStations);
    stationCones.update(pose.location, pose.altitudeMSL, snapshot.otherCameras, snapshot.selectedStationId);
    observationRays.update(pose.location, pose.altitudeMSL, snapshot.observationRays);
    cpConstraintLines.update(pose.location, pose.altitudeMSL,
      snapshot.visibleCps, snapshot.cpConstraints,
      snapshot.selectedConstraintId, snapshot.multiSelectedConstraintIds);
    cpSurfacesRenderer.update(pose.location, pose.altitudeMSL,
      snapshot.visibleCps, snapshot.cpSurfaces, snapshot.selectedSurfaceId);
    sundialMarker.update(pose.location, pose.altitudeMSL, snapshot.sundialMarkerDots);
    updateSundialLine(pose.location, pose.altitudeMSL,
      snapshot.sundialGnomonCpId, snapshot.sundialShadow);
    updateOverlaysGroupOffset();
    hud.refresh();
  }

  function pushTerrainFromPose(): void {
    const pose = worldCamera.getPose();
    if (pose.location) terrain.setLocation(pose.location);
    terrain.setCameraMSL(pose.altitudeMSL);
  }

  return {
    viewer, overlays, worldCamera,
    terrain, sky, sunMarker,
    cpColumns, stationDots, stationCones, observationRays,
    cpConstraintLines, cpSurfacesRenderer, photoPreviews,
    baker, hud,
    sundialMarker, sundialLine, sundialLinePos,
    previewLine, previewPositions,
    applyPose, pushTerrainFromPose,
  };
}
