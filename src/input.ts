import * as THREE from 'three';
import { FOV_MIN, FOV_MAX } from './viewer.js';
import type { Viewer } from './viewer.js';
import { ROLE_BODY, ROLE_HANDLE, ROLE_POI, dirFromAzAlt } from './overlay.js';
import type { OverlayManager } from './overlay.js';
import type { OverlayUserData, POIUserData, RoleUserData } from './types.js';

export const TOOL_MOVE = 'move' as const;
export const TOOL_POI = 'poi' as const;

export type Tool = typeof TOOL_MOVE | typeof TOOL_POI;

type Mode = 'pan' | 'move' | 'resize' | 'poi-drag' | null;

interface ResizeInitial {
  dist: number;
  sizeRad: number;
}

export interface InputController {
  setTool(newTool: Tool): void;
  getTool(): Tool;
  onToolChange(cb: (tool: Tool) => void): void;
}

export interface AttachInputOptions {
  viewer: Viewer;
  overlays: OverlayManager;
  onChange: () => void;
}

export function attachInput({ viewer, overlays, onChange }: AttachInputOptions): InputController {
  const { renderer, camera, overlaysGroup } = viewer;
  const canvas = renderer.domElement;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmpVec3 = new THREE.Vector3();
  const movePoint = new THREE.Vector3();
  const loader = new THREE.TextureLoader();

  function ndcFromEvent(e: { clientX: number; clientY: number }): void {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  }
  function projectToScreen(worldPos: THREE.Vector3): { x: number; y: number } {
    tmpVec3.copy(worldPos).project(camera);
    return { x: (tmpVec3.x + 1) * 0.5 * innerWidth, y: (1 - tmpVec3.y) * 0.5 * innerHeight };
  }
  function raycastOverlays(): THREE.Intersection[] {
    return raycaster.intersectObjects(overlaysGroup.children, true)
      .filter(h => (h.object.userData as RoleUserData).role);
  }

  let tool: Tool = TOOL_MOVE;
  let mode: Mode = null;
  let lastX = 0, lastY = 0;
  let resizeInitial: ResizeInitial | null = null;
  let draggingPOI: THREE.Mesh | null = null;
  let toolChangeCb: ((tool: Tool) => void) | null = null;

  function setTool(newTool: Tool): void {
    if (tool === newTool) return;
    tool = newTool;
    canvas.classList.toggle('tool-poi', tool === TOOL_POI);
    toolChangeCb?.(tool);
  }

  let batchOpen = false;
  function openBatch(): void { if (!batchOpen) { overlays.beginBatch(); batchOpen = true; } }
  function closeBatch(): void { if (batchOpen) { batchOpen = false; overlays.endBatch(); } }

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    ndcFromEvent(e);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycastOverlays();

    // Open a batch for the entire drag so per-pointermove mutations don't each
    // re-fire the solver / map redraw / bake-dirty cascade. Closed in endDrag.
    openBatch();

    if (tool === TOOL_POI) {
      const poiHit = hits.find(h => (h.object.userData as RoleUserData).role === ROLE_POI);
      const bodyHit = hits.find(h => (h.object.userData as RoleUserData).role === ROLE_BODY);
      if (poiHit) {
        const poiMesh = poiHit.object as THREE.Mesh;
        overlays.setSelectedPOI(poiMesh);
        draggingPOI = poiMesh;
        mode = 'poi-drag';
        viewer.requestRender();
      } else if (bodyHit && bodyHit.uv) {
        const o = bodyHit.object.parent as THREE.Group;
        const poi = overlays.addPOI(o, bodyHit.uv.x, bodyHit.uv.y);
        draggingPOI = poi;
        mode = 'poi-drag';
      } else {
        overlays.setSelectedPOI(null);
        mode = 'pan';
        viewer.requestRender();
      }
    } else {
      const handleHit = hits.find(h => (h.object.userData as RoleUserData).role === ROLE_HANDLE);
      const bodyHit = hits.find(h => (h.object.userData as RoleUserData).role === ROLE_BODY);
      const selected = overlays.getSelected();
      if (handleHit && selected && handleHit.object.parent === selected) {
        mode = 'resize';
        const center = projectToScreen(selected.position);
        const dx = e.clientX - center.x, dy = e.clientY - center.y;
        const sizeRad = (selected.userData as OverlayUserData).sizeRad;
        resizeInitial = { dist: Math.hypot(dx, dy) || 1, sizeRad };
      } else if (bodyHit) {
        const o = bodyHit.object.parent as THREE.Group;
        if (selected !== o) { overlays.setSelected(o); onChange(); }
        mode = 'move';
      } else {
        if (selected) { overlays.setSelected(null); onChange(); }
        mode = 'pan';
      }
    }
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  const endDrag = (): void => {
    mode = null; resizeInitial = null; draggingPOI = null;
    closeBatch();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
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
        // Mutation is inside the drag batch, so onMutate (which would normally
        // request a render) is queued. Request the render directly instead.
        viewer.requestRender();
      }
    } else if (mode === 'resize' && resizeInitial) {
      const selected = overlays.getSelected();
      if (!selected) return;
      const center = projectToScreen(selected.position);
      const dx = e.clientX - center.x, dy = e.clientY - center.y;
      const dist = Math.hypot(dx, dy);
      overlays.resizeSelectedTo(resizeInitial.sizeRad * (dist / resizeInitial.dist));
      onChange();
    } else if (mode === 'poi-drag' && draggingPOI) {
      ndcFromEvent(e);
      raycaster.setFromCamera(ndc, camera);
      // Re-raycast against the POI's parent overlay body to recompute UV.
      const parentOverlay = (draggingPOI.userData as POIUserData).parentOverlay;
      const body = (parentOverlay.userData as OverlayUserData).body;
      const hit = raycaster.intersectObject(body)[0];
      if (hit && hit.uv) {
        overlays.movePOI(draggingPOI, hit.uv.x, hit.uv.y);
        viewer.requestRender();
      }
    }
  });

  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    // Normalize deltaY to pixels: Firefox mouse wheels report LINE (≈ ±3); Chrome PIXEL (≈ ±100).
    const pxDelta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    camera.fov = THREE.MathUtils.clamp(camera.fov * Math.exp(pxDelta * 0.001), FOV_MIN, FOV_MAX);
    camera.updateProjectionMatrix();
    onChange();
  }, { passive: false });

  addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (tool === TOOL_POI && overlays.getSelectedPOI()) {
        overlays.deleteSelectedPOI();
        endDrag();
        onChange();
      } else if (overlays.getSelected()) {
        overlays.deleteSelected();
        endDrag();
        onChange();
      }
    }
  });

  addEventListener('dragover', (e: DragEvent) => e.preventDefault());
  addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    for (const file of e.dataTransfer.files) {
      if (!file.type.startsWith('image/')) continue;
      const url = URL.createObjectURL(file);
      loader.load(url, tex => {
        const img = tex.image as HTMLImageElement | undefined;
        if (!img) return;
        const aspect = img.naturalWidth / img.naturalHeight;
        const { azimuth, altitude } = viewer.getAzAlt();
        overlays.addOverlay(tex, aspect, dirFromAzAlt(azimuth, altitude));
        onChange();
        URL.revokeObjectURL(url);
      });
    }
  });

  return {
    setTool, getTool: () => tool,
    onToolChange(cb: (tool: Tool) => void): void { toolChangeCb = cb; },
  };
}
