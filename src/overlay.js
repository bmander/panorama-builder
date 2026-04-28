import * as THREE from 'three';

export const OVERLAY_R = 100;
export const DEFAULT_SIZE_RAD = Math.PI / 6;       // 30°
export const SIZE_MIN = Math.PI / 180 * 2;          // 2°
export const SIZE_MAX = Math.PI * 0.9;              // 162°

export const ROLE_BODY = 'body';
export const ROLE_HANDLE = 'handle';
export const ROLE_OUTLINE = 'outline';

const widthFromSizeRad = sr => 2 * OVERLAY_R * Math.tan(sr / 2);

export function dirFromAzAlt(az, alt) {
  const v = new THREE.Vector3(0, 0, -1);
  v.applyAxisAngle(new THREE.Vector3(1, 0, 0), alt);
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), az);
  return v;
}

export function createOverlayManager({ overlaysGroup, getAnisotropy, onMutate }) {
  const overlaySphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), OVERLAY_R);
  const notify = () => onMutate?.();
  let selected = null;

  function makeOverlay(tex, aspect) {
    const o = new THREE.Group();
    o.userData.sizeRad = DEFAULT_SIZE_RAD;
    o.userData.aspect = aspect;
    const body = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
    );
    body.userData.role = ROLE_BODY;
    o.add(body);
    o.userData.body = body;
    applySize(o);
    return o;
  }

  function applySize(o) {
    const w = widthFromSizeRad(o.userData.sizeRad);
    const h = w / o.userData.aspect;
    o.userData.body.scale.set(w, h, 1);
    if (o.userData.outline) o.userData.outline.scale.set(w, h, 1);
    if (o.userData.handles) {
      const corners = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];
      o.userData.handles.forEach((m, i) => {
        m.position.set(corners[i][0] * w, corners[i][1] * h, 0);
      });
    }
  }

  function placeAt(o, dir) {
    o.position.copy(dir).normalize().multiplyScalar(OVERLAY_R);
    o.lookAt(0, 0, 0);
  }

  function addSelectionVisuals(o) {
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true })
    );
    outline.userData.role = ROLE_OUTLINE;
    outline.renderOrder = 1;
    outline.raycast = () => {};
    o.add(outline);
    o.userData.outline = outline;

    const handleGeom = new THREE.SphereGeometry(2.5, 12, 8);
    const handleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
    o.userData.handles = [];
    [0, 1, 2, 3].forEach(i => {
      const m = new THREE.Mesh(handleGeom, handleMat);
      m.userData.role = ROLE_HANDLE;
      m.userData.cornerIndex = i;
      m.renderOrder = 2;
      o.add(m);
      o.userData.handles.push(m);
    });
    applySize(o);
  }

  function clearSelectionVisuals(o) {
    if (!o) return;
    if (o.userData.outline) {
      o.remove(o.userData.outline);
      o.userData.outline.geometry.dispose();
      o.userData.outline.material.dispose();
      delete o.userData.outline;
    }
    if (o.userData.handles) {
      o.userData.handles.forEach(m => o.remove(m));
      const first = o.userData.handles[0];
      first.geometry.dispose();
      first.material.dispose();
      delete o.userData.handles;
    }
  }

  return {
    overlaySphere,
    addOverlay(tex, aspect, dir) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = getAnisotropy();
      const o = makeOverlay(tex, aspect);
      placeAt(o, dir);
      overlaysGroup.add(o);
      this.setSelected(o);
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
      selected.userData.sizeRad = THREE.MathUtils.clamp(sizeRad, SIZE_MIN, SIZE_MAX);
      applySize(selected);
      notify();
    },
    deleteSelected() {
      if (!selected) return;
      const o = selected;
      this.setSelected(null);
      overlaysGroup.remove(o);
      o.userData.body.geometry.dispose();
      o.userData.body.material.map?.dispose();
      o.userData.body.material.dispose();
      notify();
    },
    setVisualsVisible(visible) {
      if (!selected) return;
      if (selected.userData.outline) selected.userData.outline.visible = visible;
      if (selected.userData.handles) selected.userData.handles.forEach(m => m.visible = visible);
    },
  };
}
