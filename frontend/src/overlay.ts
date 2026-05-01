import * as THREE from 'three';
import {
  lineMat,
  meshMat,
  overlayData,
  poiData,
} from './types.js';
import type {
  Cone,
  ControlPointView,
  ImageMeasurementBearing,
  LatLng,
  MapMeasurementView,
  Pose,
  Role,
} from './types.js';

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

const HANDLE_CORNERS: readonly (readonly [number, number])[] = [
  [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5],
];

export function dirFromAzAlt(az: number, alt: number): THREE.Vector3 {
  const v = new THREE.Vector3(0, 0, -1);
  v.applyAxisAngle(new THREE.Vector3(1, 0, 0), alt);
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), az);
  return v;
}

function posToAzAlt(o: THREE.Object3D): { az: number; alt: number } {
  return {
    az: Math.atan2(-o.position.x, -o.position.z),
    alt: Math.asin(o.position.y / OVERLAY_R),
  };
}

export interface AddPhotoOptions {
  readonly id: string;
}

export interface AddImageMeasurementOptions {
  readonly id: string;
  // Optional initial link to a control point — populated when the matcher
  // click creates a paired measurement.
  readonly controlPointId?: string | null;
}

export interface AddControlPointPayload {
  readonly description: string;
  readonly estLat: number | null;
  readonly estLng: number | null;
  readonly estAlt: number | null;
}

export interface OverlayManager {
  overlaySphere: THREE.Sphere;
  addOverlay(tex: THREE.Texture, aspect: number, dir: THREE.Vector3, opts: AddPhotoOptions): THREE.Group;
  getSelected(): THREE.Group | null;
  setSelected(o: THREE.Group | null): void;
  setHovered(o: THREE.Group | null): boolean;
  moveSelectedTo(point: THREE.Vector3): void;
  resizeSelectedTo(sizeRad: number): void;
  setSelectedRoll(roll: number): void;
  deleteSelected(): void;
  setOpacity(o: THREE.Group, opacity: number): void;
  getOpacity(o: THREE.Group): number;
  setSelectedOpacity(opacity: number): void;
  getSelectedOpacity(): number | null;

  // --- Image measurements (per-photo reticles) ---
  addImageMeasurement(o: THREE.Group, u: number, v: number, opts: AddImageMeasurementOptions): THREE.Mesh;
  // Update the FK link to a control point. Pass null to clear.
  setMeasurementCP(measurement: THREE.Mesh, controlPointId: string | null): void;
  moveImageMeasurement(measurement: THREE.Mesh, u: number, v: number): void;
  deleteSelectedMeasurement(): void;
  getSelectedImageMeasurement(): THREE.Mesh | null;
  setSelectedImageMeasurement(measurement: THREE.Mesh | null): void;
  // Sets image-measurement and map-measurement selection together, firing
  // onSelectionChange exactly once. Used by the matcher click.
  setSelectedPair(measurement: THREE.Mesh | null, mapMeasurementId: string | null): void;
  getImageMeasurements(): ImageMeasurementBearing[];

  // --- Map measurements (per-project ground-truth observations) ---
  addMapMeasurement(id: string, latlng: LatLng, controlPointId: string | null): void;
  // Moves the measurement marker. If the measurement is linked to a CP, the
  // CP's est_lat/est_lng are mirrored to the new latlng (v1 behavior).
  setMapMeasurementLatLng(id: string, latlng: LatLng): void;
  getMapMeasurements(): MapMeasurementView[];
  getSelectedMapMeasurement(): string | null;
  setSelectedMapMeasurement(id: string | null): void;

  // --- Control points (cross-project landmarks) ---
  addControlPoint(id: string, payload: AddControlPointPayload): void;
  getControlPoints(): ControlPointView[];
  getControlPointById(id: string): ControlPointView | null;
  // Mutates the CP's est_lat/est_lng. Fans out anchor caches on every linked
  // image measurement so columns/rays redraw at the new location.
  setControlPointEst(id: string, latlng: LatLng | null): void;
  setControlPointDescription(id: string, description: string): void;
  removeControlPoint(id: string): void;

  // --- Scene-graph identity helpers ---
  listOverlays(): THREE.Object3D[];
  getOverlayById(id: string): THREE.Group | null;
  getImageMeasurementById(id: string): THREE.Mesh | null;
  // Find the image measurement on a given overlay that's linked to a specific
  // control point, or null. Used by the matcher to dedupe re-clicks.
  getImageMeasurementOnOverlayByControlPointId(overlay: THREE.Group, controlPointId: string): THREE.Mesh | null;

  extractPose(o: THREE.Group, camLoc: LatLng | null): Pose;
  applyPose(o: THREE.Group, pose: Pose): void;
  beginBatch(): void;
  endBatch(): void;
  withBatch(fn: () => void): void;
  getCones(): Cone[];
  setVisualsVisible(visible: boolean): void;
}

export interface CreateOverlayManagerOptions {
  overlaysGroup: THREE.Group;
  getAnisotropy: () => number;
  onMutate?: () => void;
  onSelectionChange?: () => void;
  onLightMutate?: () => void;
}

interface MapMeasurementEntry {
  id: string;
  latlng: LatLng;
  controlPointId: string | null;
}

interface ControlPointEntry {
  id: string;
  description: string;
  estLat: number | null;
  estLng: number | null;
  estAlt: number | null;
}

export function createOverlayManager(
  { overlaysGroup, getAnisotropy, onMutate, onSelectionChange, onLightMutate }: CreateOverlayManagerOptions,
): OverlayManager {
  const overlaySphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), OVERLAY_R);
  let batching = 0;
  let batchedNotify = false;
  const notify = (): void => {
    if (batching > 0) { batchedNotify = true; return; }
    onMutate?.();
  };
  let selected: THREE.Group | null = null;
  let selectedImageMeasurement: THREE.Mesh | null = null;
  let hoveredOverlay: THREE.Group | null = null;

  // Per-project map measurements; v1 keeps these scoped under the loaded
  // location. Columns in the 360° view are drawn from the linked CPs (one
  // column per CP), not from these directly.
  const mapMeasurements: MapMeasurementEntry[] = [];
  let selectedMapMeasurementId: string | null = null;

  // Cross-project control points reachable from the loaded location. The
  // hydrate path populates this on project load; new CPs created at runtime
  // (via the matcher / +POI flows) get pushed here too.
  const controlPoints: ControlPointEntry[] = [];

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
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthTest: false }),
    );
    (body.userData as { role: Role }).role = ROLE_BODY;
    o.add(body);

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
      const first = handles[0];
      if (first) {
        first.geometry.dispose();
        meshMat(first).dispose();
      }
      delete data.handles;
    }
    applyOverlayDecoration(o);
  }

  // The "selected control point" is derived from whichever measurement
  // (image or map) is the primary selection. Selecting either side of a
  // match lights up the CP and every other measurement that references it.
  function selectedControlPointId(): string | null {
    if (selectedImageMeasurement) return poiData(selectedImageMeasurement).controlPointId;
    if (selectedMapMeasurementId) {
      const m = mapMeasurements.find(mm => mm.id === selectedMapMeasurementId);
      return m?.controlPointId ?? null;
    }
    return null;
  }

  function isImageMeasurementSelected(poi: THREE.Mesh, controlPointId: string | null): boolean {
    if (poi === selectedImageMeasurement) return true;
    return controlPointId !== null && controlPointId === selectedControlPointId();
  }

  function applyPOIColors(): void {
    for (const child of overlaysGroup.children) {
      const data = overlayData(child as THREE.Group);
      if (!data.pois) continue;
      for (const poi of data.pois) {
        const pData = poiData(poi);
        setPoiColor(poi, isImageMeasurementSelected(poi, pData.controlPointId) ? POI_COLOR_SELECTED : POI_COLOR);
      }
    }
  }

  const manager: OverlayManager = {
    overlaySphere,
    addOverlay(tex, aspect, dir, opts) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = getAnisotropy();
      const o = makeOverlay(tex, aspect, opts.id);
      placeAt(o, dir);
      overlaysGroup.add(o);
      manager.setSelected(o);
      notify();
      return o;
    },
    getSelected: () => selected,
    setSelected(o) {
      if (selected === o) return;
      const prev = selected;
      clearSelectionVisuals(prev);
      selected = o;
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
      const dir = new THREE.Vector3().copy(selected.position).normalize();
      placeAt(selected, dir, roll);
      notify();
    },
    deleteSelected() {
      if (!selected) return;
      const o = selected;
      manager.setSelected(null);
      if (hoveredOverlay === o) hoveredOverlay = null;
      if (selectedImageMeasurement && poiData(selectedImageMeasurement).parentOverlay === o) {
        selectedImageMeasurement = null;
      }
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
          (p.material as THREE.Material).dispose();
        }
      }
      notify();
    },
    setOpacity(o, opacity) {
      meshMat(overlayData(o).body).opacity = THREE.MathUtils.clamp(opacity, 0, 1);
      onLightMutate?.();
    },
    getOpacity: (o) => meshMat(overlayData(o).body).opacity,
    setSelectedOpacity(opacity) {
      if (!selected) return;
      manager.setOpacity(selected, opacity);
    },
    getSelectedOpacity: () => selected ? manager.getOpacity(selected) : null,

    addImageMeasurement(o, u, v, opts) {
      const measurement = new THREE.Mesh(POI_GEOM, makePoiMaterial());
      const pData = poiData(measurement);
      pData.id = opts.id;
      pData.role = ROLE_POI;
      pData.uv = { u, v };
      pData.parentOverlay = o;
      pData.controlPointId = opts.controlPointId ?? null;
      measurement.renderOrder = 3;
      o.add(measurement);
      const data = overlayData(o);
      const pois = data.pois ?? (data.pois = []);
      pois.push(measurement);
      applySize(o);
      manager.setSelectedImageMeasurement(measurement);
      notify();
      return measurement;
    },
    setMeasurementCP(measurement, controlPointId) {
      poiData(measurement).controlPointId = controlPointId;
      notify();
    },
    moveImageMeasurement(measurement, u, v) {
      const pData = poiData(measurement);
      pData.uv.u = u;
      pData.uv.v = v;
      applySize(pData.parentOverlay);
      notify();
    },
    deleteSelectedMeasurement() {
      if (selectedMapMeasurementId) {
        const deletedId = selectedMapMeasurementId;
        const i = mapMeasurements.findIndex(m => m.id === deletedId);
        if (i >= 0) mapMeasurements.splice(i, 1);
        // The CP this map measurement linked to (if any) is unaffected — it
        // lives cross-project. Image measurements that used that same CP
        // keep their FK; their column simply lacks a ground-truth observation
        // until another map measurement is added.
        selectedMapMeasurementId = null;
        onSelectionChange?.();
        notify();
        return;
      }
      if (!selectedImageMeasurement) return;
      const measurement = selectedImageMeasurement;
      manager.setSelectedImageMeasurement(null);
      const parent = poiData(measurement).parentOverlay;
      parent.remove(measurement);
      const arr = overlayData(parent).pois;
      if (arr) {
        const i = arr.indexOf(measurement);
        if (i >= 0) arr.splice(i, 1);
      }
      (measurement.material as THREE.Material).dispose();
      notify();
    },
    getSelectedImageMeasurement: () => selectedImageMeasurement,
    setSelectedImageMeasurement(measurement) {
      // Mutually exclusive with selectedMapMeasurementId — see the matching
      // setSelectedMapMeasurement below for rationale. Linked highlighting
      // still flows through poiData(measurement).controlPointId.
      if (selectedImageMeasurement === measurement
          && (measurement === null || selectedMapMeasurementId === null)) return;
      selectedImageMeasurement = measurement;
      if (measurement !== null) selectedMapMeasurementId = null;
      applyPOIColors();
      onSelectionChange?.();
    },
    setSelectedPair(measurement, mapMeasurementId) {
      const photoChanged = selectedImageMeasurement !== measurement;
      const mapChanged = selectedMapMeasurementId !== mapMeasurementId;
      if (!photoChanged && !mapChanged) return;
      if (photoChanged) selectedImageMeasurement = measurement;
      if (mapChanged) selectedMapMeasurementId = mapMeasurementId;
      applyPOIColors();
      onSelectionChange?.();
    },
    getImageMeasurements() {
      const result: ImageMeasurementBearing[] = [];
      for (const child of overlaysGroup.children) {
        const o = child as THREE.Group;
        const data = overlayData(o);
        if (!data.pois) continue;
        for (const poi of data.pois) {
          const pData = poiData(poi);
          result.push({
            id: pData.id,
            handle: poi,
            az: azFromLocal(o, poi.position.x, poi.position.y, poi.position.z),
            uv: { ...pData.uv },
            controlPointId: pData.controlPointId,
            selected: isImageMeasurementSelected(poi, pData.controlPointId),
          });
        }
      }
      return result;
    },

    addMapMeasurement(id, latlng, controlPointId) {
      mapMeasurements.push({ id, latlng: { lat: latlng.lat, lng: latlng.lng }, controlPointId });
      notify();
    },
    setMapMeasurementLatLng(id, latlng) {
      const entry = mapMeasurements.find(m => m.id === id);
      if (!entry) return;
      entry.latlng = { lat: latlng.lat, lng: latlng.lng };
      // v1 mirror: a map measurement's lat/lng is also the CP's estimated
      // location. Update the CP; downstream consumers (solver, columns,
      // bearing rays) read the CP estimate directly.
      if (entry.controlPointId) {
        const cp = controlPoints.find(c => c.id === entry.controlPointId);
        if (cp) {
          cp.estLat = latlng.lat;
          cp.estLng = latlng.lng;
        }
      }
      notify();
    },
    getMapMeasurements() {
      const cpId = selectedControlPointId();
      return mapMeasurements.map(m => ({
        id: m.id,
        latlng: m.latlng,
        controlPointId: m.controlPointId,
        selected: m.id === selectedMapMeasurementId
          || (m.controlPointId !== null && m.controlPointId === cpId),
      }));
    },
    getSelectedMapMeasurement: () => selectedMapMeasurementId,
    setSelectedMapMeasurement(id) {
      if (selectedMapMeasurementId === id
          && (id === null || selectedImageMeasurement === null)) return;
      selectedMapMeasurementId = id;
      if (id !== null) selectedImageMeasurement = null;
      applyPOIColors();
      onSelectionChange?.();
    },

    addControlPoint(id, payload) {
      controlPoints.push({
        id, description: payload.description,
        estLat: payload.estLat, estLng: payload.estLng, estAlt: payload.estAlt,
      });
      notify();
    },
    getControlPoints() {
      const sel = selectedControlPointId();
      return controlPoints.map(cp => ({
        id: cp.id,
        description: cp.description,
        estLat: cp.estLat,
        estLng: cp.estLng,
        estAlt: cp.estAlt,
        selected: cp.id === sel,
      }));
    },
    getControlPointById(id) {
      const cp = controlPoints.find(c => c.id === id);
      if (!cp) return null;
      const sel = selectedControlPointId();
      return {
        id: cp.id, description: cp.description,
        estLat: cp.estLat, estLng: cp.estLng, estAlt: cp.estAlt,
        selected: cp.id === sel,
      };
    },
    setControlPointEst(id, latlng) {
      const cp = controlPoints.find(c => c.id === id);
      if (!cp) return;
      cp.estLat = latlng?.lat ?? null;
      cp.estLng = latlng?.lng ?? null;
      notify();
    },
    setControlPointDescription(id, description) {
      const cp = controlPoints.find(c => c.id === id);
      if (!cp || cp.description === description) return;
      cp.description = description;
      notify();
    },
    removeControlPoint(id) {
      const i = controlPoints.findIndex(c => c.id === id);
      if (i < 0) return;
      controlPoints.splice(i, 1);
      // Clear linkage on dependent measurements (mirrors backend ON DELETE SET NULL).
      for (const m of mapMeasurements) {
        if (m.controlPointId === id) m.controlPointId = null;
      }
      for (const child of overlaysGroup.children) {
        const data = overlayData(child as THREE.Group);
        if (!data.pois) continue;
        for (const poi of data.pois) {
          const pd = poiData(poi);
          if (pd.controlPointId === id) pd.controlPointId = null;
        }
      }
      notify();
    },

    listOverlays: () => overlaysGroup.children,
    getOverlayById(id) {
      for (const child of overlaysGroup.children) {
        const g = child as THREE.Group;
        if (overlayData(g).id === id) return g;
      }
      return null;
    },
    getImageMeasurementById(id) {
      for (const child of overlaysGroup.children) {
        const data = overlayData(child as THREE.Group);
        if (!data.pois) continue;
        for (const p of data.pois) {
          if (poiData(p).id === id) return p;
        }
      }
      return null;
    },
    getImageMeasurementOnOverlayByControlPointId(overlay, controlPointId) {
      const data = overlayData(overlay);
      if (!data.pois) return null;
      for (const p of data.pois) {
        if (poiData(p).controlPointId === controlPointId) return p;
      }
      return null;
    },

    extractPose(o, camLoc) {
      const { az, alt } = posToAzAlt(o);
      const data = overlayData(o);
      return {
        photoAz: az,
        photoTilt: alt,
        photoRoll: data.photoRoll,
        sizeRad: data.sizeRad,
        aspect: data.aspect,
        camLat: camLoc?.lat ?? 0,
        camLng: camLoc?.lng ?? 0,
      };
    },
    applyPose(o, pose) {
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
    getCones() {
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
      for (const child of overlaysGroup.children) {
        const data = overlayData(child as THREE.Group);
        if (!data.pois) continue;
        for (const poi of data.pois) poi.visible = visible;
      }
    },
  };
  return manager;
}
