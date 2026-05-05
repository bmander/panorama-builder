import * as THREE from 'three';
import type { Viewer } from './viewer.js';
import {
  ROLE_BODY, ROLE_HANDLE_DRAG, ROLE_HANDLE_FOV, ROLE_HANDLE_ROTATE, ROLE_POI,
  dirFromAzAlt,
} from './overlay.js';
import type { OverlayManager } from './overlay.js';
import { getRole, overlayData, poiData } from './types.js';
import type { LatLng } from './types.js';
import { degToRad, dist2, norm2 } from './mathx.js';
import { snapshotPhoto, snapshotPoi } from './undo.js';
import type { PhotoSnapshot, UndoAction, UndoManager } from './undo.js';

// Discriminated state machine for the active pointer drag. `null` = no drag in
// progress. Each variant carries exactly the state its handler needs, so
// pointermove can dispatch on `mode.type` and TS narrows the rest.
interface PointerPos { x: number; y: number; }

type ModeState =
  | { type: 'pan' }
  // offset rotates the cursor's sphere-hit direction onto the photo center.
  // Captured on pointerdown so a grab on a corner-of-image handle doesn't
  // snap the photo's center to the cursor's initial position.
  | { type: 'move'; offset: THREE.Quaternion }
  | { type: 'resize'; dist: number; sizeRad: number }
  | { type: 'rotate'; cx: number; cy: number; startAngle: number; startRoll: number }
  | { type: 'poi-drag'; poi: THREE.Mesh }
  | { type: 'pinch'; startDist: number; startFov: number; p0: PointerPos; p1: PointerPos }
  | null;

const PINCH_MIN_DIST = 20;
function pinchDist(a: PointerPos, b: PointerPos): number {
  return Math.max(dist2(a.x, a.y, b.x, b.y), PINCH_MIN_DIST);
}

export interface AttachInputOptions {
  viewer: Viewer;
  overlays: OverlayManager;
  onChange: () => void;
  // Fired when the user drops an image file. The host is expected to POST a
  // photo, upload the blob, and call overlays.addOverlay with the server id.
  // tex's URL.createObjectURL is held until the host finishes — the host
  // revokes after addOverlay completes.
  onPhotoDropped?: (tex: THREE.Texture, blob: Blob, aspect: number, dir: THREE.Vector3, revokeUrl: () => void) => void;
  // Fired on shift+wheel with the same normalized px-delta the FOV path uses.
  // Routed out so the host module decides what shift-wheel does.
  onShiftWheel?: (deltaPx: number) => void;
  // Hit-test for map-POI columns at the cursor's NDC. Returns the column's
  // id and lat/lng if the cursor is within the host's screen-space radius,
  // else null. The host owns the projection math (it has the camera and
  // column list in scope).
  findColumnAtNDC?: (ndc: { x: number; y: number }) => { controlPointId: string; latlng: LatLng } | null;
  // Fired whenever the cursor enters or leaves a map-POI column. The host
  // forwards the id to the columns module so the column re-renders with the
  // hover (yellow) treatment, signalling "click here to match."
  onHoveredColumnChange?: (id: string | null) => void;
  // Right-click on a photo body. Host opens a context menu at (screenX,
  // screenY) and routes its actions back through the orchestration handlers
  // (e.g. "Add observation here" → observation modal at the given uv).
  onPhotoBodyContextMenu?: (
    overlay: THREE.Group, u: number, v: number, screenX: number, screenY: number,
  ) => void;
  onImagePOIContextMenu?: (poi: THREE.Mesh, screenX: number, screenY: number) => void;
  // Left-click on an other-station green dot. Hit-test is owned by the host
  // (it has the camera + dot list in scope); the host hands back the station
  // id so the click callback can open the station menu.
  findStationAtNDC?: (ndc: { x: number; y: number }) => { id: string } | null;
  onStationClick?: (id: string, screenX: number, screenY: number) => void;
  // Left-click on a control-point dot. The host receives the CP id plus an
  // optional body hit at the same NDC so the menu can offer "add observation
  // here" anchored to the photo behind the marker.
  onCPClick?: (
    controlPointId: string, screenX: number, screenY: number,
    bodyHit: { overlay: THREE.Group; u: number; v: number } | null,
  ) => void;
  // Records before/after snapshots for gesture-end mutations and applies
  // them on Cmd/Ctrl+Z. Optional for the index page where attachInput
  // still runs but no overlays are mutated.
  undoManager?: UndoManager;
}

export function attachInput({ viewer, overlays, onChange, onPhotoDropped, onShiftWheel, findColumnAtNDC, onHoveredColumnChange, onPhotoBodyContextMenu, onImagePOIContextMenu, findStationAtNDC, onStationClick, onCPClick, undoManager }: AttachInputOptions): void {
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

  let mode: ModeState = null;
  let lastX = 0, lastY = 0;
  const pointers = new Map<number, PointerPos>();
  // The map-POI column under the cursor (if any). Set by pointermove via the
  // host's findColumnAtNDC. While non-null the next click will create a paired
  // image-POI on the underlying photo, anchored to this column's lat/lng.
  let hoveredColumn: { controlPointId: string; latlng: LatLng } | null = null;

  function setHoveredColumn(next: { controlPointId: string; latlng: LatLng } | null): void {
    const prevId = hoveredColumn?.controlPointId ?? null;
    const nextId = next?.controlPointId ?? null;
    hoveredColumn = next;
    if (prevId !== nextId) {
      onHoveredColumnChange?.(nextId);
      canvas.classList.toggle('tool-poi', hoveredColumn !== null);
    }
  }

  let batchOpen = false;
  function openBatch(): void { if (!batchOpen) { overlays.beginBatch(); batchOpen = true; } }
  function closeBatch(): void { if (batchOpen) { batchOpen = false; overlays.endBatch(); } }

  // Snapshot captured at gesture-start (pointerdown). On gesture-end (endDrag)
  // we read the current state to form the `after` snapshot and push the pair
  // onto the undo stack.
  type GestureBefore =
    | { kind: 'photo-pose'; id: string; before: PhotoSnapshot }
    | { kind: 'poi-move'; id: string; before: { u: number; v: number } };
  let gestureBefore: GestureBefore | null = null;
  function capturePhoto(o: THREE.Group): void {
    if (!undoManager) return;
    const id = overlayData(o).id;
    const before = snapshotPhoto(overlays, id);
    if (before) gestureBefore = { kind: 'photo-pose', id, before };
  }
  function capturePoi(poi: THREE.Mesh): void {
    if (!undoManager) return;
    const id = poiData(poi).id;
    const before = snapshotPoi(overlays, id);
    if (before) gestureBefore = { kind: 'poi-move', id, before };
  }

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    // Left-click only — right-click goes to the contextmenu listener.
    if (e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // Open drag batch (if any) stays open until all fingers lift.
      const [p0, p1] = [...pointers.values()] as [PointerPos, PointerPos];
      mode = { type: 'pinch', startDist: pinchDist(p0, p1), startFov: camera.fov, p0, p1 };
      return;
    }
    if (pointers.size > 2) return;
    ndcFromEvent(e);
    // Station dots are screen-space and rendered always-on-top; intercept
    // them before any drag/pan dispatch so the click opens the station menu
    // instead of starting a pan. stopPropagation prevents the menu's own
    // document-level outside-click closer from firing on this same event
    // and immediately closing the menu we're about to open.
    const stationHit = findStationAtNDC?.({ x: ndc.x, y: ndc.y }) ?? null;
    if (stationHit && onStationClick) {
      e.stopPropagation();
      pointers.delete(e.pointerId);
      onStationClick(stationHit.id, e.clientX, e.clientY);
      return;
    }
    raycaster.setFromCamera(ndc, camera);
    const hits = raycastOverlays();

    // CP-marker click → open the CP menu. Skipped when a POI sits at the
    // same NDC; clicking an existing observation should take priority over
    // the CP marker behind it.
    const earlyPoiHit = hits.find(h => getRole(h.object) === ROLE_POI);
    if (!earlyPoiHit && onCPClick) {
      const cpHit = findColumnAtNDC?.({ x: ndc.x, y: ndc.y }) ?? null;
      if (cpHit) {
        e.stopPropagation();
        pointers.delete(e.pointerId);
        const earlyBodyHit = hits.find(h => getRole(h.object) === ROLE_BODY);
        const body = earlyBodyHit?.uv
          ? { overlay: earlyBodyHit.object.parent as THREE.Group, u: earlyBodyHit.uv.x, v: earlyBodyHit.uv.y }
          : null;
        onCPClick(cpHit.controlPointId, e.clientX, e.clientY, body);
        return;
      }
    }

    // Open a batch for the entire drag so per-pointermove mutations don't each
    // re-fire the solver / map redraw / bake-dirty cascade. Closed in endDrag.
    openBatch();

    const poiHit = earlyPoiHit;
    const dragHandleHit = hits.find(h => getRole(h.object) === ROLE_HANDLE_DRAG);
    const rotateHandleHit = hits.find(h => getRole(h.object) === ROLE_HANDLE_ROTATE);
    const fovHandleHit = hits.find(h => getRole(h.object) === ROLE_HANDLE_FOV);
    const bodyHit = hits.find(h => getRole(h.object) === ROLE_BODY);
    const selected = overlays.getSelected();

    // 1. POI hits always start a POI drag, regardless of selection state.
    if (poiHit) {
      const poiMesh = poiHit.object as THREE.Mesh;
      overlays.setSelectedImageMeasurement(poiMesh);
      capturePoi(poiMesh);
      mode = { type: 'poi-drag', poi: poiMesh };
      viewer.requestRender();
    }
    // 3a. Rotate handle on the selected photo → roll about photo center.
    else if (rotateHandleHit && selected && rotateHandleHit.object.parent === selected) {
      const center = projectToScreen(selected.position);
      capturePhoto(selected);
      mode = {
        type: 'rotate',
        cx: center.x,
        cy: center.y,
        startAngle: Math.atan2(e.clientY - center.y, e.clientX - center.x),
        startRoll: overlayData(selected).photoRoll,
      };
    }
    // 3b. Drag handle on the selected photo → move. Capture the rotation
    //     between the cursor's sphere-hit direction and the photo center so
    //     the photo doesn't snap to the cursor on grab; subsequent moves
    //     translate by the same angular delta.
    else if (dragHandleHit && selected && dragHandleHit.object.parent === selected) {
      ndcFromEvent(e);
      raycaster.setFromCamera(ndc, camera);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectSphere(overlays.overlaySphere, hit)) {
        const offset = new THREE.Quaternion().setFromUnitVectors(
          hit.normalize(),
          tmpVec3.copy(selected.position).normalize(),
        );
        capturePhoto(selected);
        mode = { type: 'move', offset };
      } else {
        mode = { type: 'pan' };
      }
    }
    // 3c. FOV handle on the selected photo → resize. The dist-from-center
    //     ratio drives the size_rad change, same math as the old corner
    //     handles — just sourced from a single dedicated icon.
    else if (fovHandleHit && selected && fovHandleHit.object.parent === selected) {
      const center = projectToScreen(selected.position);
      const dx = e.clientX - center.x, dy = e.clientY - center.y;
      capturePhoto(selected);
      mode = { type: 'resize', dist: norm2(dx, dy) || 1, sizeRad: overlayData(selected).sizeRad };
    }
    // 4. Body hit selects the photo if not already selected. Move and rotate
    //    are reachable only via the explicit handles, so a body click never
    //    starts a drag — the rest of the gesture pans the camera.
    else if (bodyHit?.uv) {
      const o = bodyHit.object.parent as THREE.Group;
      if (selected !== o) { overlays.setSelected(o); onChange(); }
      mode = { type: 'pan' };
    }
    // 5. Empty space → deselect + pan.
    else {
      if (selected) { overlays.setSelected(null); onChange(); }
      mode = { type: 'pan' };
    }
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('contextmenu', (e: MouseEvent) => {
    if (mode) return;
    ndcFromEvent(e);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycastOverlays();
    // POI sits visually on top of body, so a hit on both means the user
    // targeted the POI.
    const poiHit = hits.find(h => getRole(h.object) === ROLE_POI);
    if (poiHit && onImagePOIContextMenu) {
      e.preventDefault();
      onImagePOIContextMenu(poiHit.object as THREE.Mesh, e.clientX, e.clientY);
      return;
    }
    const bodyHit = hits.find(h => getRole(h.object) === ROLE_BODY);
    if (bodyHit?.uv && onPhotoBodyContextMenu) {
      e.preventDefault();
      onPhotoBodyContextMenu(bodyHit.object.parent as THREE.Group, bodyHit.uv.x, bodyHit.uv.y, e.clientX, e.clientY);
    }
  });

  function endDrag(): void {
    mode = null;
    closeBatch();
    if (undoManager && gestureBefore) {
      const g = gestureBefore;
      gestureBefore = null;
      let action: UndoAction | null = null;
      if (g.kind === 'photo-pose') {
        const after = snapshotPhoto(overlays, g.id);
        if (after) action = { kind: 'photo-pose', id: g.id, before: g.before, after };
      } else {
        const after = snapshotPoi(overlays, g.id);
        if (after) action = { kind: 'poi-move', id: g.id, before: g.before, after };
      }
      if (action) undoManager.record(action);
    }
  }
  function onPointerEnd(e: PointerEvent): void {
    pointers.delete(e.pointerId);
    // Smooth handoff: when a pinch ends with one finger still down, slide
    // into pan so the user can continue dragging without re-tapping.
    if (mode?.type === 'pinch' && pointers.size === 1) {
      const [remaining] = [...pointers.values()] as [PointerPos];
      mode = { type: 'pan' };
      lastX = remaining.x; lastY = remaining.y;
      return;
    }
    if (pointers.size === 0) endDrag();
  }
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('lostpointercapture', onPointerEnd);
  canvas.addEventListener('pointerleave', () => {
    if (mode) return;
    if (overlays.setHovered(null)) viewer.requestRender();
    setHoveredColumn(null);
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    const tracked = pointers.get(e.pointerId);
    if (tracked) { tracked.x = e.clientX; tracked.y = e.clientY; }
    if (mode?.type === 'pinch') {
      const before = camera.fov;
      viewer.setFov(mode.startFov * mode.startDist / pinchDist(mode.p0, mode.p1));
      if (camera.fov !== before) onChange();
      return;
    }
    if (!mode) {
      // No drag in progress — update both hover affordances:
      // 1. Map-POI column under cursor → highlights "click here to match."
      // 2. Photo edge under cursor → outlines the photo for editing.
      // Column hover takes precedence: if the cursor is over a column, we
      // suppress the edge-hover so the user gets one clear affordance.
      ndcFromEvent(e);
      raycaster.setFromCamera(ndc, camera);
      const colHit = findColumnAtNDC?.({ x: ndc.x, y: ndc.y }) ?? null;
      setHoveredColumn(colHit);
      if (colHit) {
        if (overlays.setHovered(null)) viewer.requestRender();
        return;
      }
      const hits = raycastOverlays();
      const bodyHit = hits.find(h => getRole(h.object) === ROLE_BODY);
      const hoverTarget = bodyHit ? bodyHit.object.parent as THREE.Group : null;
      if (overlays.setHovered(hoverTarget)) viewer.requestRender();
      return;
    }
    switch (mode.type) {
      case 'pan': {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        // Drag distance scaled so one screen-height ≈ one vertical FOV.
        const radPerPx = degToRad(camera.fov) / innerHeight;
        const { azimuth, altitude } = viewer.getAzAlt();
        viewer.setAzAlt(azimuth + dx * radPerPx, altitude + dy * radPerPx);
        onChange();
        break;
      }
      case 'move': {
        ndcFromEvent(e);
        raycaster.setFromCamera(ndc, camera);
        if (raycaster.ray.intersectSphere(overlays.overlaySphere, movePoint)) {
          movePoint.normalize().applyQuaternion(mode.offset);
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
        const dist = norm2(dx, dy);
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
          overlays.moveImageMeasurement(mode.poi, hit.uv.x, hit.uv.y);
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
    const before = camera.fov;
    viewer.setFov(camera.fov * Math.exp(pxDelta * 0.001));
    if (camera.fov !== before) onChange();
  }, { passive: false });

  addEventListener('keydown', (e: KeyboardEvent) => {
    // Don't intercept while the user is typing in form fields — preserves
    // native browser text-edit undo and the inline-edit flows on the CP page.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    if (undoManager && (e.metaKey || e.ctrlKey)) {
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) undoManager.redo(); else undoManager.undo();
        return;
      }
      if (k === 'y') {
        e.preventDefault();
        undoManager.redo();
        return;
      }
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      // POI selection takes priority: a selected POI (photo-attached OR
      // standalone map-POI) is the more specific target the user is acting
      // on (vs the photo it sits on).
      if (overlays.getSelectedImageMeasurement()) {
        overlays.deleteSelectedMeasurement();
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
        if (!img) { URL.revokeObjectURL(url); return; }
        const aspect = img.naturalWidth / img.naturalHeight;
        const { azimuth, altitude } = viewer.getAzAlt();
        // Hand off to the host (main.ts). The host POSTs metadata, uploads
        // the blob, then calls overlays.addOverlay with the server id. Once
        // it's done with the texture's URL it calls revokeUrl() back here.
        onPhotoDropped?.(tex, file, aspect, dirFromAzAlt(azimuth, altitude), () => { URL.revokeObjectURL(url); });
      }, undefined, () => { URL.revokeObjectURL(url); });
    }
  });

}
