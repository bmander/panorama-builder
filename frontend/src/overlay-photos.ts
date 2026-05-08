import * as THREE from 'three';
import { vecToAzAlt } from './geo.js';
import { lineMat, meshMat, overlayData } from './types.js';
import { makeCanvasTexture } from './canvas-texture.js';
import { clamp, degToRad } from './mathx.js';
import type {
  Cone,
  LatLng,
  PhotoLocks,
  Pose,
  Role,
} from './types.js';

export const OVERLAY_R = 100;
export const DEFAULT_SIZE_RAD = Math.PI / 6;       // 30°
export const SIZE_MIN = degToRad(2);
export const SIZE_MAX = Math.PI * 0.9;             // 162°

export const ROLE_BODY = 'body' satisfies Role;
export const ROLE_OUTLINE = 'outline' satisfies Role;
export const ROLE_HANDLE_DRAG = 'handle-drag' satisfies Role;
export const ROLE_HANDLE_ROTATE = 'handle-rotate' satisfies Role;
export const ROLE_HANDLE_FOV = 'handle-fov' satisfies Role;

// Action-handle radius: a chunky chunk of the photo width so the icons stay
// touchable without overwhelming small overlays.
const ACTION_HANDLE_FRACTION = 0.05;

const ACTION_HANDLE_GEOM = new THREE.PlaneGeometry(1, 1);

export const widthFromSizeRad = (sr: number): number => 2 * OVERLAY_R * Math.tan(sr / 2);

// Build a per-photo MeshBasicMaterial that applies forward Brown-Conrady
// radial distortion to its texture-sample UV. Each material owns its own
// uK1/uK2/uW/uAspect uniforms (mutated by applyPose / applySize); the
// compiled program is shared across all photos via customProgramCacheKey.
// When uK1 = uK2 = 0 the shader path is a numerical no-op.
//
// Distortion is applied in *tan-space* normalized image coords
// (x = (u-0.5)·W, y = (v-0.5)·W/aspect, where W = 2·tan(sizeRad/2)) to match
// the solver's ProjectPOI; otherwise the units of k1/k2 the solver fits would
// not match the shader's, and a solve would make residuals worse.
interface DistortionUniforms {
  uK1: { value: number };
  uK2: { value: number };
  uW: { value: number };
  uAspect: { value: number };
}

function makeDistortionMaterial(tex: THREE.Texture, aspect: number): THREE.MeshBasicMaterial {
  const uniforms: DistortionUniforms = {
    uK1: { value: 0 }, uK2: { value: 0 },
    uW: { value: 2 * Math.tan(DEFAULT_SIZE_RAD / 2) },
    uAspect: { value: aspect },
  };
  const material = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, side: THREE.DoubleSide, depthTest: false,
  });
  material.onBeforeCompile = (shader): void => {
    shader.uniforms.uK1 = uniforms.uK1;
    shader.uniforms.uK2 = uniforms.uK2;
    shader.uniforms.uW = uniforms.uW;
    shader.uniforms.uAspect = uniforms.uAspect;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
       uniform float uK1;
       uniform float uK2;
       uniform float uW;
       uniform float uAspect;`,
    ).replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec2 _photoC = vMapUv - 0.5;
        // Distortion model lives in tan-space (x = c.x * uW, y = c.y * uW / uAspect),
        // matching the solver's ProjectPOI undistortion.
        vec2 _photoXY = vec2(_photoC.x * uW, _photoC.y * uW / uAspect);
        float _photoR2 = dot(_photoXY, _photoXY);
        float _photoF = 1.0 + uK1 * _photoR2 + uK2 * _photoR2 * _photoR2;
        vec4 sampledDiffuseColor = texture2D(map, _photoC * _photoF + 0.5);
        diffuseColor *= sampledDiffuseColor;
       #endif`,
    );
  };
  material.customProgramCacheKey = (): string => 'photo-distortion';
  (material.userData as { distortionUniforms: DistortionUniforms }).distortionUniforms = uniforms;
  return material;
}

export function dirFromAzAlt(az: number, alt: number): THREE.Vector3 {
  const v = new THREE.Vector3(0, 0, -1);
  v.applyAxisAngle(new THREE.Vector3(1, 0, 0), alt);
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), az);
  return v;
}

// Shared scratch Object3D positioned at OVERLAY_R in the photo's pointing
// direction with -Z facing the origin (Object3D.lookAt's non-camera path
// swaps eye/target, so the matrix's +Z column ends up pointing back at
// the origin — callers that want the camera's forward vector negate it).
// The pixel-to-world transform used by null-cp-rays / observation-rays
// relies on the photo plane sitting at OVERLAY_R; station-cones reads
// only the basis vectors so the radius is irrelevant there.
const _poseScratch = new THREE.Object3D();
export function buildPoseObject(az: number, tilt: number, roll: number): THREE.Object3D {
  _poseScratch.position.copy(dirFromAzAlt(az, tilt)).normalize().multiplyScalar(OVERLAY_R);
  _poseScratch.lookAt(0, 0, 0);
  if (roll !== 0) _poseScratch.rotateZ(roll);
  _poseScratch.updateMatrixWorld();
  return _poseScratch;
}

function posToAzAlt(o: THREE.Object3D): { az: number; alt: number } {
  return vecToAzAlt(o.position.x, o.position.y, o.position.z);
}

const azScratch = new THREE.Vector3();
export function azFromLocal(o: THREE.Object3D, lx: number, ly: number, lz: number): number {
  o.updateMatrixWorld();
  azScratch.set(lx, ly, lz).applyMatrix4(o.matrixWorld);
  return Math.atan2(-azScratch.x, -azScratch.z);
}

// Lazy-built canvas textures for the drag/rotate/fov icons. White ink with a
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

let fovIconTex: THREE.Texture | null = null;
function getFovIconTexture(): THREE.Texture {
  if (fovIconTex) return fovIconTex;
  fovIconTex = makeCanvasTexture(32, ctx => {
    strokeOutlinedPath(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(8, 8); ctx.lineTo(24, 24);
      ctx.moveTo(8, 8); ctx.lineTo(8, 14);
      ctx.moveTo(8, 8); ctx.lineTo(14, 8);
      ctx.moveTo(24, 24); ctx.lineTo(24, 18);
      ctx.moveTo(24, 24); ctx.lineTo(18, 24);
    });
  });
  return fovIconTex;
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

export interface AddPhotoOptions {
  readonly id: string;
}

export interface PhotoStore {
  overlaySphere: THREE.Sphere;
  add(tex: THREE.Texture, aspect: number, dir: THREE.Vector3, opts: AddPhotoOptions): THREE.Group;
  addPending(aspect: number, dir: THREE.Vector3, opts: AddPhotoOptions): THREE.Group;
  setTexture(o: THREE.Group, tex: THREE.Texture): void;
  setAspect(o: THREE.Group, aspect: number): void;
  list(): THREE.Object3D[];
  getById(id: string): THREE.Group | null;
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
  getLocks(o: THREE.Group): PhotoLocks;
  setLocks(o: THREE.Group, locks: PhotoLocks): void;
  extractPose(o: THREE.Group, camLoc: LatLng | null): Pose;
  applyPose(o: THREE.Group, pose: Pose): void;
  getCones(): Cone[];
  setVisualsVisible(visible: boolean): void;
}

export interface CreatePhotoStoreOptions {
  overlaysGroup: THREE.Group;
  getAnisotropy: () => number;
  notify: () => void;
  notifyLight: () => void;
  layoutPoisOn: (o: THREE.Group, w: number, h: number) => void;
  disposePoisOn: (o: THREE.Group) => void;
  clearMeasurementSelectionForOverlay: (o: THREE.Group) => void;
}

export function createPhotoStore(
  {
    overlaysGroup,
    getAnisotropy,
    notify,
    notifyLight,
    layoutPoisOn,
    disposePoisOn,
    clearMeasurementSelectionForOverlay,
  }: CreatePhotoStoreOptions,
): PhotoStore {
  const overlaySphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), OVERLAY_R);
  let selected: THREE.Group | null = null;
  let hoveredOverlay: THREE.Group | null = null;

  function makeOverlay(tex: THREE.Texture, aspect: number, id?: string): THREE.Group {
    const o = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      makeDistortionMaterial(tex, aspect),
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
    data.distK1 = 0;
    data.distK2 = 0;
    data.lockDistK1 = true;
    data.lockDistK2 = true;
    data.body = body;
    data.outline = outline;
    applySize(o);
    return o;
  }

  // Sync the photo body's distortion uniforms with the overlay's current
  // pose. uW changes with sizeRad (so applySize calls this too); uK1/uK2
  // change with the user's distortion edits or solver writeback.
  function applyDistortionUniforms(o: THREE.Group): void {
    const data = overlayData(o);
    const mat = data.body.material as THREE.MeshBasicMaterial & {
      userData: { distortionUniforms?: DistortionUniforms };
    };
    const u = mat.userData.distortionUniforms;
    if (!u) return;
    u.uK1.value = data.distK1;
    u.uK2.value = data.distK2;
    u.uW.value = 2 * Math.tan(data.sizeRad / 2);
    u.uAspect.value = data.aspect;
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
    applyDistortionUniforms(o);
    layoutPoisOn(o, w, h);
    if (data.dragHandle && data.rotateHandle && data.fovHandle) {
      const r = w * ACTION_HANDLE_FRACTION;
      const yAbove = h / 2 + 1.5 * r;
      // Row of three at the upper-right: drag, rotate, fov, spaced 2r apart.
      // drag sits just inside the photo's right edge so the trio reads as
      // a single attached toolbar.
      const xRight = w / 2 + r;
      const place = (m: THREE.Mesh, x: number): void => {
        m.position.set(x, yAbove, 0);
        m.scale.setScalar(2 * r);
      };
      place(data.dragHandle, xRight - 2 * r);
      place(data.rotateHandle, xRight);
      place(data.fovHandle, xRight + 2 * r);
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
    const data = overlayData(o);
    data.dragHandle = makeActionHandle(ROLE_HANDLE_DRAG, getDragIconTexture());
    data.rotateHandle = makeActionHandle(ROLE_HANDLE_ROTATE, getRotateIconTexture());
    data.fovHandle = makeActionHandle(ROLE_HANDLE_FOV, getFovIconTexture());
    o.add(data.dragHandle, data.rotateHandle, data.fovHandle);
    applySize(o);
    applyOverlayDecoration(o);
  }

  function clearSelectionVisuals(o: THREE.Group | null): void {
    if (!o) return;
    const data = overlayData(o);
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
    if (data.fovHandle) {
      o.remove(data.fovHandle);
      meshMat(data.fovHandle).dispose();
      delete data.fovHandle;
    }
    applyOverlayDecoration(o);
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
    store.setSelected(o);
    notify();
    return o;
  }

  const store: PhotoStore = {
    overlaySphere,
    add(tex, aspect, dir, opts) {
      preparePhotoTexture(tex);
      return placeNewOverlay(tex, aspect, dir, opts);
    },
    addPending(aspect, dir, opts) {
      return placeNewOverlay(getPlaceholderTexture(), aspect, dir, opts);
    },
    setTexture(o, tex) {
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
    setAspect(o, aspect) {
      const data = overlayData(o);
      if (data.aspect === aspect) return;
      data.aspect = aspect;
      applySize(o);
      notify();
    },
    list: () => overlaysGroup.children,
    getById(id) {
      for (const child of overlaysGroup.children) {
        const g = child as THREE.Group;
        if (overlayData(g).id === id) return g;
      }
      return null;
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
      overlayData(selected).sizeRad = clamp(sizeRad, SIZE_MIN, SIZE_MAX);
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
      store.setSelected(null);
      if (hoveredOverlay === o) hoveredOverlay = null;
      clearMeasurementSelectionForOverlay(o);
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
      disposePoisOn(o);
      notify();
    },
    setOpacity(o, opacity) {
      meshMat(overlayData(o).body).opacity = clamp(opacity, 0, 1);
      notifyLight();
    },
    getOpacity: (o) => meshMat(overlayData(o).body).opacity,
    setSelectedOpacity(opacity) {
      if (!selected) return;
      store.setOpacity(selected, opacity);
    },
    getSelectedOpacity: () => selected ? store.getOpacity(selected) : null,
    getLocks(o) {
      const d = overlayData(o);
      return {
        lockPhotoAz: d.lockPhotoAz,
        lockPhotoTilt: d.lockPhotoTilt,
        lockPhotoRoll: d.lockPhotoRoll,
        lockSizeRad: d.lockSizeRad,
        lockDistK1: d.lockDistK1,
        lockDistK2: d.lockDistK2,
      };
    },
    setLocks(o, locks) {
      const d = overlayData(o);
      d.lockPhotoAz = locks.lockPhotoAz;
      d.lockPhotoTilt = locks.lockPhotoTilt;
      d.lockPhotoRoll = locks.lockPhotoRoll;
      d.lockSizeRad = locks.lockSizeRad;
      d.lockDistK1 = locks.lockDistK1;
      d.lockDistK2 = locks.lockDistK2;
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
        k1: data.distK1,
        k2: data.distK2,
      };
    },
    applyPose(o, pose) {
      overlayData(o).photoRoll = pose.photoRoll;
      placeAt(o, dirFromAzAlt(pose.photoAz, pose.photoTilt), pose.photoRoll);
      overlayData(o).sizeRad = clamp(pose.sizeRad, SIZE_MIN, SIZE_MAX);
      overlayData(o).distK1 = pose.k1;
      overlayData(o).distK2 = pose.k2;
      applySize(o); // also re-syncs distortion uniforms (uW + uK1/uK2)
      notify();
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
        if (data.dragHandle) data.dragHandle.visible = visible;
        if (data.rotateHandle) data.rotateHandle.visible = visible;
        if (data.fovHandle) data.fovHandle.visible = visible;
      }
    },
  };
  return store;
}
