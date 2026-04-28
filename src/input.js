import * as THREE from 'three';
import { PITCH_LIMIT, FOV_MIN, FOV_MAX } from './viewer.js';
import { ROLE_BODY, ROLE_HANDLE, dirFromAzAlt } from './overlay.js';

export function attachInput({ viewer, overlays, onChange }) {
  const { renderer, camera, overlaysGroup } = viewer;
  const canvas = renderer.domElement;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmpVec3 = new THREE.Vector3();
  const movePoint = new THREE.Vector3();
  const loader = new THREE.TextureLoader();

  function ndcFromEvent(e) {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  }
  function projectToScreen(worldPos) {
    tmpVec3.copy(worldPos).project(camera);
    return { x: (tmpVec3.x + 1) * 0.5 * innerWidth, y: (1 - tmpVec3.y) * 0.5 * innerHeight };
  }

  let mode = null;        // 'pan' | 'move' | 'resize' | null
  let lastX = 0, lastY = 0;
  let resizeInitial = null;

  canvas.addEventListener('pointerdown', e => {
    ndcFromEvent(e);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(overlaysGroup.children, true)
      .filter(h => h.object.userData.role === ROLE_BODY || h.object.userData.role === ROLE_HANDLE);
    const handleHit = hits.find(h => h.object.userData.role === ROLE_HANDLE);
    const bodyHit = hits.find(h => h.object.userData.role === ROLE_BODY);

    const selected = overlays.getSelected();
    if (handleHit && handleHit.object.parent === selected) {
      mode = 'resize';
      const center = projectToScreen(selected.position);
      const dx = e.clientX - center.x, dy = e.clientY - center.y;
      resizeInitial = { dist: Math.hypot(dx, dy) || 1, sizeRad: selected.userData.sizeRad };
    } else if (bodyHit) {
      const o = bodyHit.object.parent;
      if (selected !== o) { overlays.setSelected(o); onChange(); }
      mode = 'move';
    } else {
      if (selected) { overlays.setSelected(null); onChange(); }
      mode = 'pan';
    }
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  const endDrag = () => { mode = null; resizeInitial = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  canvas.addEventListener('pointermove', e => {
    if (!mode) return;
    if (mode === 'pan') {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      // Drag distance scaled so one screen-height ≈ one vertical FOV.
      const radPerPx = THREE.MathUtils.degToRad(camera.fov) / innerHeight;
      const { azimuth, altitude } = viewer.getAzAlt();
      viewer.setAzAlt(azimuth + dx * radPerPx, altitude + dy * radPerPx);
      onChange();
    } else if (mode === 'move') {
      ndcFromEvent(e);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectSphere(overlays.overlaySphere, movePoint)) {
        overlays.moveSelectedTo(movePoint);
      }
    } else if (mode === 'resize' && resizeInitial) {
      const selected = overlays.getSelected();
      if (!selected) return;
      const center = projectToScreen(selected.position);
      const dx = e.clientX - center.x, dy = e.clientY - center.y;
      const dist = Math.hypot(dx, dy);
      overlays.resizeSelectedTo(resizeInitial.sizeRad * (dist / resizeInitial.dist));
      onChange();
    }
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    // Normalize deltaY to pixels: Firefox mouse wheels report LINE (≈ ±3); Chrome PIXEL (≈ ±100).
    const pxDelta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    camera.fov = THREE.MathUtils.clamp(camera.fov * Math.exp(pxDelta * 0.001), FOV_MIN, FOV_MAX);
    camera.updateProjectionMatrix();
    onChange();
  }, { passive: false });

  addEventListener('keydown', e => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && overlays.getSelected()) {
      overlays.deleteSelected();
      endDrag();
      onChange();
    }
  });

  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => {
    e.preventDefault();
    for (const file of e.dataTransfer.files) {
      if (!file.type.startsWith('image/')) continue;
      const url = URL.createObjectURL(file);
      loader.load(url, tex => {
        const aspect = tex.image.naturalWidth / tex.image.naturalHeight;
        const { azimuth, altitude } = viewer.getAzAlt();
        overlays.addOverlay(tex, aspect, dirFromAzAlt(azimuth, altitude));
        onChange();
        URL.revokeObjectURL(url);
      });
    }
  });
}
