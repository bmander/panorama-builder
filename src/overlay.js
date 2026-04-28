import * as THREE from 'three';

export const OVERLAY_R = 100;
export const DEFAULT_SIZE_RAD = Math.PI / 6;       // 30°
export const SIZE_MIN = Math.PI / 180 * 2;          // 2°
export const SIZE_MAX = Math.PI * 0.9;              // 162°

export const ROLE_BODY = 'body';
export const ROLE_HANDLE = 'handle';
export const ROLE_OUTLINE = 'outline';
export const ROLE_POI = 'poi';

const POI_COLOR = 0xff5050;
const POI_COLOR_SELECTED = 0xffff66;
// POI sphere radius = this fraction of the overlay's world width — scales with the photo.
const POI_WIDTH_FRACTION = 0.012;

const widthFromSizeRad = sr => 2 * OVERLAY_R * Math.tan(sr / 2);

export function dirFromAzAlt(az, alt) {
  const v = new THREE.Vector3(0, 0, -1);
  v.applyAxisAngle(new THREE.Vector3(1, 0, 0), alt);
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), az);
  return v;
}

// Inverse of dirFromAzAlt for objects placed on the OVERLAY_R sphere via placeAt().
function posToAzAlt(o) {
  return {
    az: Math.atan2(-o.position.x, -o.position.z),
    alt: Math.asin(o.position.y / OVERLAY_R),
  };
}

export function createOverlayManager({ overlaysGroup, getAnisotropy, onMutate }) {
  const overlaySphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), OVERLAY_R);
  let batching = 0;
  let batchedNotify = false;
  const notify = () => {
    if (batching > 0) { batchedNotify = true; return; }
    onMutate?.();
  };
  let selected = null;
  let selectedPOI = null;

  // Returns viewer-azimuth (CCW from -Z) of a point given in an overlay's local frame.
  const azScratch = new THREE.Vector3();
  function azFromLocal(o, lx, ly, lz) {
    o.updateMatrixWorld();
    azScratch.set(lx, ly, lz).applyMatrix4(o.matrixWorld);
    return Math.atan2(-azScratch.x, -azScratch.z);
  }
  // Returns elevation (asin(y/|v|)) of the same point — needed by the pose solver.
  function elFromLocal(o, lx, ly, lz) {
    o.updateMatrixWorld();
    azScratch.set(lx, ly, lz).applyMatrix4(o.matrixWorld);
    return Math.asin(azScratch.y / azScratch.length());
  }

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
    if (o.userData.pois) {
      const r = w * POI_WIDTH_FRACTION;
      for (const poi of o.userData.pois) {
        const { u, v } = poi.userData.uv;
        poi.position.set((u - 0.5) * w, (v - 0.5) * h, 0);
        poi.scale.setScalar(r);
      }
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
      // Drop selectedPOI if it lived on this overlay; bypass setSelectedPOI so we
      // don't try to recolor a material that's about to be disposed.
      if (selectedPOI?.userData.parentOverlay === o) selectedPOI = null;
      overlaysGroup.remove(o);
      o.userData.body.geometry.dispose();
      o.userData.body.material.map?.dispose();
      o.userData.body.material.dispose();
      if (o.userData.pois) {
        for (const p of o.userData.pois) { p.geometry.dispose(); p.material.dispose(); }
      }
      notify();
    },
    addPOI(o, u, v) {
      // Unit sphere; applySize() scales it per overlay width.
      const poi = new THREE.Mesh(
        new THREE.SphereGeometry(1, 12, 8),
        new THREE.MeshBasicMaterial({ color: POI_COLOR, depthTest: false, transparent: true }),
      );
      poi.userData.role = ROLE_POI;
      poi.userData.uv = { u, v };
      poi.userData.parentOverlay = o;
      poi.userData.mapAnchor = null;
      poi.renderOrder = 3;
      o.add(poi);
      (o.userData.pois ??= []).push(poi);
      applySize(o);
      this.setSelectedPOI(poi);
      notify();
      return poi;
    },
    setPOIMapAnchor(poi, latlng) {
      poi.userData.mapAnchor = latlng ? { lat: latlng.lat, lng: latlng.lng } : null;
      notify();
    },
    listOverlays: () => overlaysGroup.children,
    extractPose(o, camLoc) {
      const { az, alt } = posToAzAlt(o);
      return {
        photoAz: az,
        photoTilt: alt,                 // input only; solver does not modify
        sizeRad: o.userData.sizeRad,
        aspect: o.userData.aspect,
        camLat: camLoc?.lat ?? 0,
        camLng: camLoc?.lng ?? 0,
      };
    },
    applyPose(o, pose) {
      // photoTilt is preserved (solver doesn't touch it; pass it through).
      placeAt(o, dirFromAzAlt(pose.photoAz, pose.photoTilt));
      o.userData.sizeRad = THREE.MathUtils.clamp(pose.sizeRad, SIZE_MIN, SIZE_MAX);
      applySize(o);
      notify();
    },
    beginBatch() { batching++; },
    endBatch() {
      batching--;
      if (batching === 0 && batchedNotify) { batchedNotify = false; onMutate?.(); }
    },
    withBatch(fn) {
      this.beginBatch();
      try { fn(); } finally { this.endBatch(); }
    },
    movePOI(poi, u, v) {
      poi.userData.uv.u = u;
      poi.userData.uv.v = v;
      applySize(poi.userData.parentOverlay);
      notify();
    },
    deleteSelectedPOI() {
      if (!selectedPOI) return;
      const poi = selectedPOI;
      this.setSelectedPOI(null);
      const parent = poi.userData.parentOverlay;
      parent.remove(poi);
      const arr = parent.userData.pois;
      const i = arr.indexOf(poi); if (i >= 0) arr.splice(i, 1);
      poi.geometry.dispose();
      poi.material.dispose();
      notify();
    },
    getSelectedPOI: () => selectedPOI,
    setSelectedPOI(poi) {
      if (selectedPOI === poi) return;
      if (selectedPOI) selectedPOI.material.color.setHex(POI_COLOR);
      selectedPOI = poi;
      if (selectedPOI) selectedPOI.material.color.setHex(POI_COLOR_SELECTED);
    },
    getPOIs() {
      const result = [];
      for (const o of overlaysGroup.children) {
        if (!o.userData.pois) continue;
        for (const poi of o.userData.pois) {
          result.push({
            handle: poi,
            az: azFromLocal(o, poi.position.x, poi.position.y, poi.position.z),
            uv: { ...poi.userData.uv },
            mapAnchor: poi.userData.mapAnchor,
          });
        }
      }
      return result;
    },
    getCones() {
      // Sample each vertical edge at its centerline (y=0). For tilted overlays the
      // local Y axis isn't purely world-vertical, so picking y=0 (the edge midpoint)
      // gives a stable bearing instead of biasing toward the bottom corner.
      const cones = [];
      for (const o of overlaysGroup.children) {
        const w = widthFromSizeRad(o.userData.sizeRad);
        cones.push({
          azL: azFromLocal(o, -w / 2, 0, 0),
          azR: azFromLocal(o, +w / 2, 0, 0),
        });
      }
      return cones;
    },
    setVisualsVisible(visible) {
      if (!selected) return;
      if (selected.userData.outline) selected.userData.outline.visible = visible;
      if (selected.userData.handles) selected.userData.handles.forEach(m => m.visible = visible);
    },
  };
}
