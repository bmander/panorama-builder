import * as THREE from 'three';
import {
  lineMat,
  meshMat,
  overlayData,
  poiData,
} from './types.js';
import type {
  Cone,
  LatLng,
  POIBearing,
  Pose,
  Role,
} from './types.js';
import type { OverlaySnapshot } from './persistence.js';

export const OVERLAY_R = 100;
export const DEFAULT_SIZE_RAD = Math.PI / 6;       // 30°
export const SIZE_MIN = (Math.PI / 180) * 2;       // 2°
export const SIZE_MAX = Math.PI * 0.9;             // 162°

export const ROLE_BODY = 'body' satisfies Role;
export const ROLE_HANDLE = 'handle' satisfies Role;
export const ROLE_OUTLINE = 'outline' satisfies Role;
export const ROLE_POI = 'poi' satisfies Role;

const POI_COLOR = 0xff5050;
const POI_COLOR_SELECTED = 0xffff66;
// POI sphere radius = this fraction of the overlay's world width — scales with the photo.
const POI_WIDTH_FRACTION = 0.012;

const widthFromSizeRad = (sr: number): number => 2 * OVERLAY_R * Math.tan(sr / 2);

// Corner offsets (in unit-rectangle coordinates) for the 4 selection handles,
// matching the order produced by addSelectionVisuals.
const HANDLE_CORNERS: readonly (readonly [number, number])[] = [
  [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5],
];

export function dirFromAzAlt(az: number, alt: number): THREE.Vector3 {
  const v = new THREE.Vector3(0, 0, -1);
  v.applyAxisAngle(new THREE.Vector3(1, 0, 0), alt);
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), az);
  return v;
}

// Inverse of dirFromAzAlt for objects placed on the OVERLAY_R sphere via placeAt().
function posToAzAlt(o: THREE.Object3D): { az: number; alt: number } {
  return {
    az: Math.atan2(-o.position.x, -o.position.z),
    alt: Math.asin(o.position.y / OVERLAY_R),
  };
}

export interface OverlayManager {
  overlaySphere: THREE.Sphere;
  addOverlay(tex: THREE.Texture, aspect: number, dir: THREE.Vector3): THREE.Group;
  // Restores an overlay from persisted state. Skips selection visuals; the
  // caller wraps a batch of restoreOverlay calls in withBatch so onMutate
  // fires once at the end (not per-overlay).
  restoreOverlay(tex: THREE.Texture, snapshot: OverlaySnapshot): THREE.Group;
  getSelected(): THREE.Group | null;
  setSelected(o: THREE.Group | null): void;
  moveSelectedTo(point: THREE.Vector3): void;
  resizeSelectedTo(sizeRad: number): void;
  deleteSelected(): void;
  addPOI(o: THREE.Group, u: number, v: number): THREE.Mesh;
  setPOIMapAnchor(poi: THREE.Mesh, latlng: LatLng | null): void;
  listOverlays(): THREE.Object3D[];
  extractPose(o: THREE.Group, camLoc: LatLng | null): Pose;
  applyPose(o: THREE.Group, pose: Pose): void;
  beginBatch(): void;
  endBatch(): void;
  withBatch(fn: () => void): void;
  movePOI(poi: THREE.Mesh, u: number, v: number): void;
  deleteSelectedPOI(): void;
  getSelectedPOI(): THREE.Mesh | null;
  setSelectedPOI(poi: THREE.Mesh | null): void;
  getPOIs(): POIBearing[];
  getCones(): Cone[];
  setVisualsVisible(visible: boolean): void;
}

export interface CreateOverlayManagerOptions {
  overlaysGroup: THREE.Group;
  getAnisotropy: () => number;
  onMutate?: () => void;
}

export function createOverlayManager(
  { overlaysGroup, getAnisotropy, onMutate }: CreateOverlayManagerOptions,
): OverlayManager {
  const overlaySphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), OVERLAY_R);
  let batching = 0;
  let batchedNotify = false;
  const notify = (): void => {
    if (batching > 0) { batchedNotify = true; return; }
    onMutate?.();
  };
  let selected: THREE.Group | null = null;
  let selectedPOI: THREE.Mesh | null = null;

  // Returns viewer-azimuth (CCW from -Z) of a point given in an overlay's local frame.
  const azScratch = new THREE.Vector3();
  function azFromLocal(o: THREE.Object3D, lx: number, ly: number, lz: number): number {
    o.updateMatrixWorld();
    azScratch.set(lx, ly, lz).applyMatrix4(o.matrixWorld);
    return Math.atan2(-azScratch.x, -azScratch.z);
  }

  function makeOverlay(tex: THREE.Texture, aspect: number, id?: string): THREE.Group {
    const o = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
    );
    (body.userData as { role: Role }).role = ROLE_BODY;
    o.add(body);
    const data = overlayData(o);
    data.id = id ?? crypto.randomUUID();
    data.sizeRad = DEFAULT_SIZE_RAD;
    data.aspect = aspect;
    data.body = body;
    applySize(o);
    return o;
  }

  function applySize(o: THREE.Group): void {
    const data = overlayData(o);
    const w = widthFromSizeRad(data.sizeRad);
    const h = w / data.aspect;
    data.body.scale.set(w, h, 1);
    if (data.outline) data.outline.scale.set(w, h, 1);
    if (data.handles) {
      data.handles.forEach((m, i) => {
        const c = HANDLE_CORNERS[i];
        if (!c) return;
        m.position.set(c[0] * w, c[1] * h, 0);
      });
    }
    if (data.pois) {
      const r = w * POI_WIDTH_FRACTION;
      for (const poi of data.pois) {
        const { u, v } = poiData(poi).uv;
        poi.position.set((u - 0.5) * w, (v - 0.5) * h, 0);
        poi.scale.setScalar(r);
      }
    }
  }

  function placeAt(o: THREE.Object3D, dir: THREE.Vector3): void {
    o.position.copy(dir).normalize().multiplyScalar(OVERLAY_R);
    o.lookAt(0, 0, 0);
  }

  function addSelectionVisuals(o: THREE.Group): void {
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }),
    );
    (outline.userData as { role: Role }).role = ROLE_OUTLINE;
    outline.renderOrder = 1;
    // Outlines are visual-only; opt out of raycaster hits.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    outline.raycast = () => {};
    o.add(outline);
    overlayData(o).outline = outline;

    const handleGeom = new THREE.SphereGeometry(2.5, 12, 8);
    const handleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
    const handles: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(handleGeom, handleMat);
      (m.userData as { role: Role }).role = ROLE_HANDLE;
      m.renderOrder = 2;
      o.add(m);
      handles.push(m);
    }
    overlayData(o).handles = handles;
    applySize(o);
  }

  function clearSelectionVisuals(o: THREE.Group | null): void {
    if (!o) return;
    const data = overlayData(o);
    if (data.outline) {
      o.remove(data.outline);
      data.outline.geometry.dispose();
      lineMat(data.outline).dispose();
      delete data.outline;
    }
    if (data.handles) {
      const handles = data.handles;
      for (const m of handles) o.remove(m);
      // All handles share one geometry & material — dispose once via the first.
      const first = handles[0];
      if (first) {
        first.geometry.dispose();
        meshMat(first).dispose();
      }
      delete data.handles;
    }
  }

  const manager: OverlayManager = {
    overlaySphere,
    addOverlay(tex, aspect, dir) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = getAnisotropy();
      const o = makeOverlay(tex, aspect);
      placeAt(o, dir);
      overlaysGroup.add(o);
      manager.setSelected(o);
      notify();
      return o;
    },
    restoreOverlay(tex, snapshot) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = getAnisotropy();
      const o = makeOverlay(tex, snapshot.aspect, snapshot.id);
      overlayData(o).sizeRad = THREE.MathUtils.clamp(snapshot.sizeRad, SIZE_MIN, SIZE_MAX);
      placeAt(o, dirFromAzAlt(snapshot.photoAz, snapshot.photoTilt));
      applySize(o);
      overlaysGroup.add(o);
      for (const p of snapshot.pois) {
        // addPOI assumes selection visuals; bypass it here and add directly.
        const poi = new THREE.Mesh(
          new THREE.SphereGeometry(1, 12, 8),
          new THREE.MeshBasicMaterial({ color: POI_COLOR, depthTest: false, transparent: true }),
        );
        const pdata = poiData(poi);
        pdata.role = ROLE_POI;
        pdata.uv = { u: p.u, v: p.v };
        pdata.parentOverlay = o;
        pdata.mapAnchor = p.mapAnchor;
        poi.renderOrder = 3;
        o.add(poi);
        const data = overlayData(o);
        data.pois ??= [];
        data.pois.push(poi);
      }
      applySize(o); // apply now that POIs are attached so they get scaled too
      notify();
      return o;
    },
    getSelected: () => selected,
    setSelected(o) {
      if (selected === o) return;
      clearSelectionVisuals(selected);
      selected = o;
      if (selected) addSelectionVisuals(selected);
    },
    moveSelectedTo(point) {
      if (!selected) return;
      selected.position.copy(point);
      selected.lookAt(0, 0, 0);
      notify();
    },
    resizeSelectedTo(sizeRad) {
      if (!selected) return;
      overlayData(selected).sizeRad = THREE.MathUtils.clamp(sizeRad, SIZE_MIN, SIZE_MAX);
      applySize(selected);
      notify();
    },
    deleteSelected() {
      if (!selected) return;
      const o = selected;
      manager.setSelected(null);
      // Drop selectedPOI if it lived on this overlay; bypass setSelectedPOI so we
      // don't try to recolor a material that's about to be disposed.
      if (selectedPOI && poiData(selectedPOI).parentOverlay === o) selectedPOI = null;
      overlaysGroup.remove(o);
      const data = overlayData(o);
      data.body.geometry.dispose();
      const bodyMat = meshMat(data.body);
      bodyMat.map?.dispose();
      bodyMat.dispose();
      if (data.pois) {
        for (const p of data.pois) {
          p.geometry.dispose();
          meshMat(p).dispose();
        }
      }
      notify();
    },
    addPOI(o, u, v) {
      // Unit sphere; applySize() scales it per overlay width.
      const poi = new THREE.Mesh(
        new THREE.SphereGeometry(1, 12, 8),
        new THREE.MeshBasicMaterial({ color: POI_COLOR, depthTest: false, transparent: true }),
      );
      const pData = poiData(poi);
      pData.role = ROLE_POI;
      pData.uv = { u, v };
      pData.parentOverlay = o;
      pData.mapAnchor = null;
      poi.renderOrder = 3;
      o.add(poi);
      const data = overlayData(o);
      const pois = data.pois ?? (data.pois = []);
      pois.push(poi);
      applySize(o);
      manager.setSelectedPOI(poi);
      notify();
      return poi;
    },
    setPOIMapAnchor(poi, latlng) {
      poiData(poi).mapAnchor = latlng ? { lat: latlng.lat, lng: latlng.lng } : null;
      notify();
    },
    listOverlays: () => overlaysGroup.children,
    extractPose(o, camLoc) {
      const { az, alt } = posToAzAlt(o);
      const data = overlayData(o);
      return {
        photoAz: az,
        photoTilt: alt,                 // input only; solver does not modify
        sizeRad: data.sizeRad,
        aspect: data.aspect,
        camLat: camLoc?.lat ?? 0,
        camLng: camLoc?.lng ?? 0,
      };
    },
    applyPose(o, pose) {
      // photoTilt is preserved (solver doesn't touch it; pass it through).
      placeAt(o, dirFromAzAlt(pose.photoAz, pose.photoTilt));
      overlayData(o).sizeRad = THREE.MathUtils.clamp(pose.sizeRad, SIZE_MIN, SIZE_MAX);
      applySize(o);
      notify();
    },
    beginBatch() { batching++; },
    endBatch() {
      batching--;
      if (batching === 0 && batchedNotify) { batchedNotify = false; onMutate?.(); }
    },
    withBatch(fn) {
      manager.beginBatch();
      try { fn(); } finally { manager.endBatch(); }
    },
    movePOI(poi, u, v) {
      const pData = poiData(poi);
      pData.uv.u = u;
      pData.uv.v = v;
      applySize(pData.parentOverlay);
      notify();
    },
    deleteSelectedPOI() {
      if (!selectedPOI) return;
      const poi = selectedPOI;
      manager.setSelectedPOI(null);
      const parent = poiData(poi).parentOverlay;
      parent.remove(poi);
      const arr = overlayData(parent).pois;
      if (arr) {
        const i = arr.indexOf(poi);
        if (i >= 0) arr.splice(i, 1);
      }
      poi.geometry.dispose();
      meshMat(poi).dispose();
      notify();
    },
    getSelectedPOI: () => selectedPOI,
    setSelectedPOI(poi) {
      if (selectedPOI === poi) return;
      if (selectedPOI) meshMat(selectedPOI).color.setHex(POI_COLOR);
      selectedPOI = poi;
      if (selectedPOI) meshMat(selectedPOI).color.setHex(POI_COLOR_SELECTED);
    },
    getPOIs() {
      const result: POIBearing[] = [];
      for (const child of overlaysGroup.children) {
        const o = child as THREE.Group;
        const data = overlayData(o);
        if (!data.pois) continue;
        for (const poi of data.pois) {
          const pData = poiData(poi);
          result.push({
            handle: poi,
            az: azFromLocal(o, poi.position.x, poi.position.y, poi.position.z),
            uv: { ...pData.uv },
            mapAnchor: pData.mapAnchor,
          });
        }
      }
      return result;
    },
    getCones() {
      // Sample each vertical edge at its centerline (y=0). For tilted overlays the
      // local Y axis isn't purely world-vertical, so picking y=0 (the edge midpoint)
      // gives a stable bearing instead of biasing toward the bottom corner.
      const cones: Cone[] = [];
      for (const child of overlaysGroup.children) {
        const o = child as THREE.Group;
        const w = widthFromSizeRad(overlayData(o).sizeRad);
        cones.push({
          azL: azFromLocal(o, -w / 2, 0, 0),
          azR: azFromLocal(o, w / 2, 0, 0),
        });
      }
      return cones;
    },
    setVisualsVisible(visible) {
      if (selected) {
        const data = overlayData(selected);
        if (data.outline) data.outline.visible = visible;
        if (data.handles) for (const m of data.handles) m.visible = visible;
      }
      // POIs are authoring markers — hide them along with the selection visuals
      // so the bake captures only the photographic content.
      for (const child of overlaysGroup.children) {
        const data = overlayData(child as THREE.Group);
        if (!data.pois) continue;
        for (const poi of data.pois) poi.visible = visible;
      }
    },
  };
  return manager;
}
