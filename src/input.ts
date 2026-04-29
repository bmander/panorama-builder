import * as THREE from 'three';
import { FOV_MIN, FOV_MAX } from './viewer.js';
import type { Viewer } from './viewer.js';
import { ROLE_BODY, ROLE_HANDLE, ROLE_POI, dirFromAzAlt } from './overlay.js';
import type { OverlayManager } from './overlay.js';
import { getRole, overlayData, poiData } from './types.js';

export type Tool = 'move' | 'poi';
export const TOOL_MOVE = 'move' satisfies Tool;
export const TOOL_POI = 'poi' satisfies Tool;

// Discriminated state machine for the active pointer drag. `null` = no drag in
// progress. Each variant carries exactly the state its handler needs, so
// pointermove can dispatch on `mode.type` and TS narrows the rest.
type ModeState =
  | { type: 'pan' }
  | { type: 'move' }
  | { type: 'resize'; dist: number; sizeRad: number }
  | { type: 'rotate'; cx: number; cy: number; startAngle: number; startRoll: number }
  | { type: 'poi-drag'; poi: THREE.Mesh }
  | null;

export interface InputController {
  setTool(newTool: Tool): void;
  getTool(): Tool;
  onToolChange(cb: (tool: Tool) => void): void;
}

export interface AttachInputOptions {
  viewer: Viewer;
  overlays: OverlayManager;
  onChange: () => void;
  // Fired right after a dropped file becomes a new overlay. The Blob is the
  // original dropped File so persistence can stash it before the URL is
  // revoked. Optional — the app works without it.
  onOverlayAdded?: (overlay: THREE.Group, blob: Blob) => void;
  // Fired on shift+wheel with the same normalized px-delta the FOV path uses.
  // Routed out so the host module decides what shift-wheel does.
  onShiftWheel?: (deltaPx: number) => void;
}

export function attachInput({ viewer, overlays, onChange, onOverlayAdded, onShiftWheel }: AttachInputOptions): InputController {
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
      .filter(h => getRole(h.object) !== undefined);
  }

  let tool: Tool = TOOL_MOVE;
  let mode: ModeState = null;
  let lastX = 0, lastY = 0;
  const toolChangeCbs: ((tool: Tool) => void)[] = [];

  function setTool(newTool: Tool): void {
    if (tool === newTool) return;
    tool = newTool;
    canvas.classList.toggle('tool-poi', tool === TOOL_POI);
    for (const cb of toolChangeCbs) cb(tool);
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
      const poiHit = hits.find(h => getRole(h.object) === ROLE_POI);
      const bodyHit = hits.find(h => getRole(h.object) === ROLE_BODY);
      if (poiHit) {
        const poiMesh = poiHit.object as THREE.Mesh;
        overlays.setSelectedPOI(poiMesh);
        mode = { type: 'poi-drag', poi: poiMesh };
        viewer.requestRender();
      } else if (bodyHit?.uv) {
        const o = bodyHit.object.parent as THREE.Group;
        const poi = overlays.addPOI(o, bodyHit.uv.x, bodyHit.uv.y);
        mode = { type: 'poi-drag', poi };
      } else {
        overlays.setSelectedPOI(null);
        mode = { type: 'pan' };
        viewer.requestRender();
      }
    } else {
      const handleHit = hits.find(h => getRole(h.object) === ROLE_HANDLE);
      const bodyHit = hits.find(h => getRole(h.object) === ROLE_BODY);
      const selected = overlays.getSelected();
      if (handleHit && selected && handleHit.object.parent === selected) {
        const center = projectToScreen(selected.position);
        const dx = e.clientX - center.x, dy = e.clientY - center.y;
        mode = {
          type: 'resize',
          dist: Math.hypot(dx, dy) || 1,
          sizeRad: overlayData(selected).sizeRad,
        };
      } else if (bodyHit) {
        const o = bodyHit.object.parent as THREE.Group;
        if (selected !== o) { overlays.setSelected(o); onChange(); }
        if (e.shiftKey) {
          const center = projectToScreen(o.position);
          mode = {
            type: 'rotate',
            cx: center.x,
            cy: center.y,
            startAngle: Math.atan2(e.clientY - center.y, e.clientX - center.x),
            startRoll: overlayData(o).photoRoll,
          };
        } else {
          mode = { type: 'move' };
        }
      } else {
        if (selected) { overlays.setSelected(null); onChange(); }
        mode = { type: 'pan' };
      }
    }
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  const endDrag = (): void => {
    mode = null;
    closeBatch();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (!mode) return;
    switch (mode.type) {
      case 'pan': {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        // Drag distance scaled so one screen-height ≈ one vertical FOV.
        const radPerPx = THREE.MathUtils.degToRad(camera.fov) / innerHeight;
        const { azimuth, altitude } = viewer.getAzAlt();
        viewer.setAzAlt(azimuth + dx * radPerPx, altitude + dy * radPerPx);
        onChange();
        break;
      }
      case 'move': {
        ndcFromEvent(e);
        raycaster.setFromCamera(ndc, camera);
        if (raycaster.ray.intersectSphere(overlays.overlaySphere, movePoint)) {
          overlays.moveSelectedTo(movePoint);
          // Mutation is inside the drag batch, so onMutate (which would normally
          // request a render) is queued. Request the render directly instead.
          viewer.requestRender();
        }
        break;
      }
      case 'resize': {
        const selected = overlays.getSelected();
        if (!selected) return;
        const center = projectToScreen(selected.position);
        const dx = e.clientX - center.x, dy = e.clientY - center.y;
        const dist = Math.hypot(dx, dy);
        overlays.resizeSelectedTo(mode.sizeRad * (dist / mode.dist));
        onChange();
        break;
      }
      case 'rotate': {
        // Pointer atan2 with screen-Y-down: a CW pointer sweep gives a positive
        // delta. The overlay's local +Z points away from camera, so o.rotateZ
        // with positive roll appears CCW to the viewer — flip the sign so a CW
        // drag rotates the photo CW.
        const currentAngle = Math.atan2(e.clientY - mode.cy, e.clientX - mode.cx);
        overlays.setSelectedRoll(mode.startRoll - (currentAngle - mode.startAngle));
        viewer.requestRender();
        break;
      }
      case 'poi-drag': {
        ndcFromEvent(e);
        raycaster.setFromCamera(ndc, camera);
        // Re-raycast against the POI's parent overlay body to recompute UV.
        const body = overlayData(poiData(mode.poi).parentOverlay).body;
        const hit = raycaster.intersectObject(body)[0];
        if (hit?.uv) {
          overlays.movePOI(mode.poi, hit.uv.x, hit.uv.y);
          viewer.requestRender();
        }
        break;
      }
    }
  });

  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    // Chrome/Firefox translate Shift+vertical-wheel into horizontal scroll, so
    // when shift is held the value lands in deltaX, not deltaY. Fall back so
    // shift-wheel works regardless.
    const rawDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    // Normalize to pixels: Firefox mouse wheels report LINE (≈ ±3); Chrome PIXEL (≈ ±100).
    const pxDelta = e.deltaMode === 1 ? rawDelta * 30 : e.deltaMode === 2 ? rawDelta * 400 : rawDelta;
    if (e.shiftKey && onShiftWheel) {
      onShiftWheel(pxDelta);
      return;
    }
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

  addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); });
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
        const overlay = overlays.addOverlay(tex, aspect, dirFromAzAlt(azimuth, altitude));
        onOverlayAdded?.(overlay, file);
        onChange();
        URL.revokeObjectURL(url);
      });
    }
  });

  return {
    setTool, getTool: () => tool,
    onToolChange(cb: (tool: Tool) => void): void { toolChangeCbs.push(cb); },
  };
}
