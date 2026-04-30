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
// POI radius = this fraction of the overlay's world width — scales with the photo.
const POI_WIDTH_FRACTION = 0.018;

// POI marker: crosshair-inside-a-circle, drawn procedurally on a 2×2 plane so
// the lines stay crisp at any scale. A small gap at the center exposes the
// target pixel for precise placement.
function makePoiMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(POI_COLOR) } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 color;
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        float ring = 1.0 - smoothstep(0.04, 0.06, abs(r - 0.7));
        float chh = (1.0 - smoothstep(0.03, 0.05, abs(p.y))) * step(0.10, abs(p.x)) * step(abs(p.x), 0.85);
        float chv = (1.0 - smoothstep(0.03, 0.05, abs(p.x))) * step(0.10, abs(p.y)) * step(abs(p.y), 0.85);
        float a = max(ring, max(chh, chv));
        if (a < 0.01) discard;
        gl_FragColor = vec4(color, a);
      }
    `,
    transparent: true,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  material.customProgramCacheKey = (): string => 'poi-reticle';
  return material;
}

function setPoiColor(poi: THREE.Mesh, hex: number): void {
  const mat = poi.material as THREE.ShaderMaterial;
  (mat.uniforms.color!.value as THREE.Color).setHex(hex);
}

const POI_GEOM = new THREE.PlaneGeometry(2, 2);

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
  // Marks an overlay as the hover target so its outline becomes visible (the
  // visual "this is editable" affordance). Independent of selection. Returns
  // true if the hover target actually changed; lets callers skip a render.
  setHovered(o: THREE.Group | null): boolean;
  moveSelectedTo(point: THREE.Vector3): void;
  resizeSelectedTo(sizeRad: number): void;
  // In-plane roll (radians, CCW positive). Re-applies position + lookAt so the
  // rotation lands on top of a clean orientation (otherwise rotateZ would
  // accumulate against whatever the previous quaternion happened to be).
  setSelectedRoll(roll: number): void;
  deleteSelected(): void;
  // Per-photo body opacity in [0, 1]. Touches only the material — caller is
  // responsible for the cheap render/save sequence (no full onMutate, since
  // opacity doesn't affect the solver, map cones, or POIs).
  setSelectedOpacity(opacity: number): void;
  getSelectedOpacity(): number | null;
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
  // Separate from onMutate so consumers refresh selection-dependent visuals
  // without paying the solver/save cascade.
  onSelectionChange?: () => void;
}

export function createOverlayManager(
  { overlaysGroup, getAnisotropy, onMutate, onSelectionChange }: CreateOverlayManagerOptions,
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
  let hoveredOverlay: THREE.Group | null = null;

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
      // depthTest: false keeps photos in front of terrain regardless of
      // whether the photo plane physically intersects it. Photo↔photo order
      // is handled by Three.js's transparent back-to-front sort.
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthTest: false }),
    );
    (body.userData as { role: Role }).role = ROLE_BODY;
    o.add(body);

    // Outline is always present; visibility is driven by selected || hovered.
    // This lets the input layer "preview" a photo's editable status by toggling
    // hover, without adding/removing scene-graph objects on every cursor move.
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }),
    );
    (outline.userData as { role: Role }).role = ROLE_OUTLINE;
    outline.renderOrder = 1;
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    outline.raycast = () => {};
    outline.visible = false;
    o.add(outline);

    const data = overlayData(o);
    data.id = id ?? crypto.randomUUID();
    data.sizeRad = DEFAULT_SIZE_RAD;
    data.aspect = aspect;
    data.photoRoll = 0;
    data.body = body;
    data.outline = outline;
    applySize(o);
    return o;
  }

  function applyOverlayDecoration(o: THREE.Group): void {
    const data = overlayData(o);
    if (data.outline) data.outline.visible = (selected === o) || (hoveredOverlay === o);
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

  function placeAt(o: THREE.Object3D, dir: THREE.Vector3, roll = 0): void {
    o.position.copy(dir).normalize().multiplyScalar(OVERLAY_R);
    o.lookAt(0, 0, 0);
    if (roll !== 0) o.rotateZ(roll);
  }

  function addSelectionVisuals(o: THREE.Group): void {
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
    applyOverlayDecoration(o);
  }

  function clearSelectionVisuals(o: THREE.Group | null): void {
    if (!o) return;
    const data = overlayData(o);
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
    applyOverlayDecoration(o);
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
      overlayData(o).photoRoll = snapshot.photoRoll ?? 0;
      placeAt(o, dirFromAzAlt(snapshot.photoAz, snapshot.photoTilt), overlayData(o).photoRoll);
      applySize(o);
      if (snapshot.opacity !== undefined) {
        meshMat(overlayData(o).body).opacity = snapshot.opacity;
      }
      overlaysGroup.add(o);
      for (const p of snapshot.pois) {
        // addPOI assumes selection visuals; bypass it here and add directly.
        const poi = new THREE.Mesh(POI_GEOM, makePoiMaterial());
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
      const prev = selected;
      clearSelectionVisuals(prev);
      selected = o;
      // applyOverlayDecoration on the previously-selected so its outline
      // can fall back to hover-only state (or hide).
      if (prev && prev !== o) applyOverlayDecoration(prev);
      if (selected) addSelectionVisuals(selected);
    },
    setHovered(o) {
      if (hoveredOverlay === o) return false;
      const prev = hoveredOverlay;
      hoveredOverlay = o;
      if (prev) applyOverlayDecoration(prev);
      if (o) applyOverlayDecoration(o);
      return true;
    },
    moveSelectedTo(point) {
      if (!selected) return;
      placeAt(selected, point, overlayData(selected).photoRoll);
      notify();
    },
    resizeSelectedTo(sizeRad) {
      if (!selected) return;
      overlayData(selected).sizeRad = THREE.MathUtils.clamp(sizeRad, SIZE_MIN, SIZE_MAX);
      applySize(selected);
      notify();
    },
    setSelectedRoll(roll) {
      if (!selected) return;
      if (overlayData(selected).photoRoll === roll) return;
      overlayData(selected).photoRoll = roll;
      // Re-derive direction from current position so this works mid-drag,
      // before any move-event has called placeAt on this overlay.
      const dir = new THREE.Vector3().copy(selected.position).normalize();
      placeAt(selected, dir, roll);
      notify();
    },
    deleteSelected() {
      if (!selected) return;
      const o = selected;
      manager.setSelected(null);
      if (hoveredOverlay === o) hoveredOverlay = null;
      // Drop selectedPOI if it lived on this overlay; bypass setSelectedPOI so we
      // don't try to recolor a material that's about to be disposed.
      if (selectedPOI && poiData(selectedPOI).parentOverlay === o) selectedPOI = null;
      overlaysGroup.remove(o);
      const data = overlayData(o);
      data.body.geometry.dispose();
      const bodyMat = meshMat(data.body);
      bodyMat.map?.dispose();
      bodyMat.dispose();
      if (data.outline) {
        data.outline.geometry.dispose();
        lineMat(data.outline).dispose();
      }
      if (data.pois) {
        for (const p of data.pois) {
          // POIs share POI_GEOM (don't dispose) but each has its own material.
          (p.material as THREE.Material).dispose();
        }
      }
      notify();
    },
    setSelectedOpacity(opacity) {
      if (!selected) return;
      meshMat(overlayData(selected).body).opacity = THREE.MathUtils.clamp(opacity, 0, 1);
    },
    getSelectedOpacity: () => selected ? meshMat(overlayData(selected).body).opacity : null,
    addPOI(o, u, v) {
      // Unit-radius reticle plane; applySize() scales it per overlay width.
      const poi = new THREE.Mesh(POI_GEOM, makePoiMaterial());
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
        photoRoll: data.photoRoll,      // input only; solver does not modify
        sizeRad: data.sizeRad,
        aspect: data.aspect,
        camLat: camLoc?.lat ?? 0,
        camLng: camLoc?.lng ?? 0,
      };
    },
    applyPose(o, pose) {
      // photoTilt and photoRoll are preserved (solver doesn't touch them).
      overlayData(o).photoRoll = pose.photoRoll;
      placeAt(o, dirFromAzAlt(pose.photoAz, pose.photoTilt), pose.photoRoll);
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
      // POI shares POI_GEOM; only the material is per-POI.
      (poi.material as THREE.Material).dispose();
      notify();
    },
    getSelectedPOI: () => selectedPOI,
    setSelectedPOI(poi) {
      if (selectedPOI === poi) return;
      if (selectedPOI) setPoiColor(selectedPOI, POI_COLOR);
      selectedPOI = poi;
      if (selectedPOI) setPoiColor(selectedPOI, POI_COLOR_SELECTED);
      onSelectionChange?.();
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
            selected: poi === selectedPOI,
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
