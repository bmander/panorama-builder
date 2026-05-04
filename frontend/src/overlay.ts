import * as THREE from 'three';
import { vecToAzAlt } from './geo.js';
import {
  lineMat,
  makeCanvasTexture,
  meshMat,
  overlayData,
  poiData,
} from './types.js';
import type {
  Cone,
  ControlPointView,
  ImageMeasurementBearing,
  LatLng,
  PhotoLocks,
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
export const ROLE_HANDLE_DRAG = 'handle-drag' satisfies Role;
export const ROLE_HANDLE_ROTATE = 'handle-rotate' satisfies Role;

const POI_COLOR = 0xff5050;
const POI_COLOR_SELECTED = 0xffff66;
// POI radius = this fraction of the overlay's world width — scales with the photo.
const POI_WIDTH_FRACTION = 0.018;
// Action-handle radius: a chunky chunk of the photo width so the icons stay
// touchable without overwhelming small overlays.
const ACTION_HANDLE_FRACTION = 0.05;

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
const ACTION_HANDLE_GEOM = new THREE.PlaneGeometry(1, 1);

// Lazy-built canvas textures for the drag and rotate icons. White ink with a
// faint dark outline so they read against any photo background.
function strokeOutlinedPath(ctx: CanvasRenderingContext2D, draw: () => void): void {
  draw();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

let dragIconTex: THREE.Texture | null = null;
function getDragIconTexture(): THREE.Texture {
  if (dragIconTex) return dragIconTex;
  // Plus-shape with arrowheads — the standard "move" affordance.
  dragIconTex = makeCanvasTexture(32, ctx => {
    strokeOutlinedPath(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(16, 4); ctx.lineTo(16, 28);
      ctx.moveTo(4, 16); ctx.lineTo(28, 16);
      ctx.moveTo(12, 8); ctx.lineTo(16, 4); ctx.lineTo(20, 8);
      ctx.moveTo(12, 24); ctx.lineTo(16, 28); ctx.lineTo(20, 24);
      ctx.moveTo(8, 12); ctx.lineTo(4, 16); ctx.lineTo(8, 20);
      ctx.moveTo(24, 12); ctx.lineTo(28, 16); ctx.lineTo(24, 20);
    });
  });
  return dragIconTex;
}

let rotateIconTex: THREE.Texture | null = null;
function getRotateIconTexture(): THREE.Texture {
  if (rotateIconTex) return rotateIconTex;
  // Three-quarter circle arrow — the standard "rotate" affordance.
  rotateIconTex = makeCanvasTexture(32, ctx => {
    strokeOutlinedPath(ctx, () => {
      ctx.beginPath();
      ctx.arc(16, 16, 10, -Math.PI * 0.25, Math.PI * 1.25);
      const tipX = 16 + 10 * Math.cos(-Math.PI * 0.25);
      const tipY = 16 + 10 * Math.sin(-Math.PI * 0.25);
      ctx.moveTo(tipX, tipY); ctx.lineTo(20, 4);
      ctx.moveTo(tipX, tipY); ctx.lineTo(28, 8);
    });
  });
  return rotateIconTex;
}

// Lazy so the canvas isn't created on the index page (no overlays there).
let placeholderTex: THREE.Texture | null = null;
function getPlaceholderTexture(): THREE.Texture {
  if (placeholderTex) return placeholderTex;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(0, 0, 16, 16);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  for (let i = -16; i < 32; i += 4) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 16, 16);
    ctx.stroke();
  }
  placeholderTex = new THREE.CanvasTexture(c);
  return placeholderTex;
}

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
  return vecToAzAlt(o.position.x, o.position.y, o.position.z);
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
  readonly estAlt: number;
}

export interface OverlayManager {
  overlaySphere: THREE.Sphere;
  addOverlay(tex: THREE.Texture, aspect: number, dir: THREE.Vector3, opts: AddPhotoOptions): THREE.Group;
  addPendingOverlay(aspect: number, dir: THREE.Vector3, opts: AddPhotoOptions): THREE.Group;
  setOverlayTexture(o: THREE.Group, tex: THREE.Texture): void;
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
  getPhotoLocks(o: THREE.Group): PhotoLocks;
  setPhotoLocks(o: THREE.Group, locks: PhotoLocks): void;

  // --- Image measurements (per-photo reticles) ---
  addImageMeasurement(o: THREE.Group, u: number, v: number, opts: AddImageMeasurementOptions): THREE.Mesh;
  // Update the FK link to a control point. Pass null to clear.
  setMeasurementCP(measurement: THREE.Mesh, controlPointId: string | null): void;
  moveImageMeasurement(measurement: THREE.Mesh, u: number, v: number): void;
  deleteSelectedMeasurement(): void;
  getSelectedImageMeasurement(): THREE.Mesh | null;
  setSelectedImageMeasurement(measurement: THREE.Mesh | null): void;
  getImageMeasurements(): ImageMeasurementBearing[];

  // --- Control points (cross-station landmarks) ---
  addControlPoint(id: string, payload: AddControlPointPayload): void;
  getControlPoints(): ControlPointView[];
  getControlPointById(id: string): ControlPointView | null;
  // Mutates the CP's full estimate (lat, lng, alt). Pass alt every time —
  // omitting it would let the cached value drift out of sync with the server
  // after a solver writeback.
  setControlPointEst(id: string, est: { lat: number | null; lng: number | null; alt: number }): void;
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

interface ControlPointEntry {
  id: string;
  description: string;
  estLat: number | null;
  estLng: number | null;
  estAlt: number;
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

  // Cross-station control points reachable from the loaded station. The
  // hydrate path populates this on station load; new CPs created at runtime
  // (via the matcher) get pushed here too.
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
    data.lockPhotoAz = false;
    data.lockPhotoTilt = false;
    data.lockPhotoRoll = false;
    data.lockSizeRad = false;
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
    if (data.dragHandle && data.rotateHandle) {
      const r = w * ACTION_HANDLE_FRACTION;
      const yAbove = h / 2 + 1.5 * r;
      const xRight = w / 2 + r;
      data.dragHandle.position.set(xRight - 2 * r, yAbove, 0);
      data.dragHandle.scale.setScalar(2 * r);
      data.rotateHandle.position.set(xRight, yAbove, 0);
      data.rotateHandle.scale.setScalar(2 * r);
    }
  }

  function placeAt(o: THREE.Object3D, dir: THREE.Vector3, roll = 0): void {
    o.position.copy(dir).normalize().multiplyScalar(OVERLAY_R);
    o.lookAt(0, 0, 0);
    if (roll !== 0) o.rotateZ(roll);
  }

  function makeActionHandle(role: Role, tex: THREE.Texture): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(ACTION_HANDLE_GEOM, mat);
    (m.userData as { role: Role }).role = role;
    m.renderOrder = 2;
    return m;
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
    const data = overlayData(o);
    data.handles = handles;
    data.dragHandle = makeActionHandle(ROLE_HANDLE_DRAG, getDragIconTexture());
    data.rotateHandle = makeActionHandle(ROLE_HANDLE_ROTATE, getRotateIconTexture());
    o.add(data.dragHandle);
    o.add(data.rotateHandle);
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
    if (data.dragHandle) {
      o.remove(data.dragHandle);
      meshMat(data.dragHandle).dispose();
      delete data.dragHandle;
    }
    if (data.rotateHandle) {
      o.remove(data.rotateHandle);
      meshMat(data.rotateHandle).dispose();
      delete data.rotateHandle;
    }
    applyOverlayDecoration(o);
  }

  // The selected CP is derived from the selected image measurement, so a
  // selection lights up every other measurement referencing the same CP.
  function selectedControlPointId(): string | null {
    if (selectedImageMeasurement) return poiData(selectedImageMeasurement).controlPointId;
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

  function preparePhotoTexture(tex: THREE.Texture): void {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = getAnisotropy();
  }

  // The placeholder is shared across pending overlays; only photo textures
  // are 1:1 with their owning material and safe to dispose here.
  function disposeBodyTexture(mat: THREE.MeshBasicMaterial): void {
    if (mat.map && mat.map !== placeholderTex) mat.map.dispose();
  }

  function placeNewOverlay(tex: THREE.Texture, aspect: number, dir: THREE.Vector3, opts: AddPhotoOptions): THREE.Group {
    const o = makeOverlay(tex, aspect, opts.id);
    placeAt(o, dir);
    overlaysGroup.add(o);
    manager.setSelected(o);
    notify();
    return o;
  }

  const manager: OverlayManager = {
    overlaySphere,
    addOverlay(tex, aspect, dir, opts) {
      preparePhotoTexture(tex);
      return placeNewOverlay(tex, aspect, dir, opts);
    },
    addPendingOverlay(aspect, dir, opts) {
      return placeNewOverlay(getPlaceholderTexture(), aspect, dir, opts);
    },
    setOverlayTexture(o, tex) {
      // Overlay was removed (e.g., user deleted the photo) before its blob
      // arrived. Drop the texture rather than orphaning it on a disposed
      // material.
      if (!o.parent) { tex.dispose(); return; }
      preparePhotoTexture(tex);
      const mat = overlayData(o).body.material as THREE.MeshBasicMaterial;
      disposeBodyTexture(mat);
      mat.map = tex;
      mat.needsUpdate = true;
      notify();
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
      disposeBodyTexture(bodyMat);
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
    getPhotoLocks(o) {
      const d = overlayData(o);
      return {
        lockPhotoAz: d.lockPhotoAz,
        lockPhotoTilt: d.lockPhotoTilt,
        lockPhotoRoll: d.lockPhotoRoll,
        lockSizeRad: d.lockSizeRad,
      };
    },
    setPhotoLocks(o, locks) {
      const d = overlayData(o);
      d.lockPhotoAz = locks.lockPhotoAz;
      d.lockPhotoTilt = locks.lockPhotoTilt;
      d.lockPhotoRoll = locks.lockPhotoRoll;
      d.lockSizeRad = locks.lockSizeRad;
    },

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
      if (selectedImageMeasurement === measurement) return;
      selectedImageMeasurement = measurement;
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
    setControlPointEst(id, est) {
      const cp = controlPoints.find(c => c.id === id);
      if (!cp) return;
      if (cp.estLat === est.lat && cp.estLng === est.lng && cp.estAlt === est.alt) return;
      cp.estLat = est.lat;
      cp.estLng = est.lng;
      cp.estAlt = est.alt;
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
      // Clear linkage on dependent image measurements (mirrors the backend
      // ON DELETE SET NULL on image_measurements.control_point_id).
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
