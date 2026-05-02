import * as THREE from 'three';
import type { Viewer } from './viewer.js';
import { ROLE_BODY, ROLE_HANDLE, ROLE_POI, dirFromAzAlt } from './overlay.js';
import type { OverlayManager } from './overlay.js';
import { getRole, overlayData, poiData } from './types.js';
import type { LatLng } from './types.js';

// Hits inside this UV-distance from any edge of an overlay's body count as
// "edge" and select the photo. The interior is treated as click-through (pans
// the camera) for an unselected photo.
const EDGE_THRESHOLD = 0.08;

function isOnEdge(uv: THREE.Vector2): boolean {
  return Math.min(uv.x, 1 - uv.x, uv.y, 1 - uv.y) < EDGE_THRESHOLD;
}

// Discriminated state machine for the active pointer drag. `null` = no drag in
// progress. Each variant carries exactly the state its handler needs, so
// pointermove can dispatch on `mode.type` and TS narrows the rest.
interface PointerPos { x: number; y: number; }

type ModeState =
  | { type: 'pan' }
  | { type: 'move' }
  | { type: 'resize'; dist: number; sizeRad: number }
  | { type: 'rotate'; cx: number; cy: number; startAngle: number; startRoll: number }
  | { type: 'poi-drag'; poi: THREE.Mesh }
  | { type: 'pinch'; startDist: number; startFov: number; p0: PointerPos; p1: PointerPos }
  | null;

const PINCH_MIN_DIST = 20;
function pinchDist(a: PointerPos, b: PointerPos): number {
  return Math.max(Math.hypot(b.x - a.x, b.y - a.y), PINCH_MIN_DIST);
}

export interface InputController {
  // Toggles the "next click adds a POI" armed state. Click → arm; click again
  // (or click-miss) → un-arm. Fires onPoiArmChange whenever the state flips.
  togglePoiArm(): void;
  // Forces the armed state off; no-op if already off. Used on tab-switch to
  // avoid stale arming carrying across views.
  disarmPoi(): void;
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
  // Fired when the user clicks on a photo body with "+ POI" armed. Host
  // POSTs an image-poi (no map_poi_id) then calls overlays.addPOI with the
  // server id.
  onAddImagePOI?: (overlay: THREE.Group, u: number, v: number) => void;
  // Fired when the user matches a hovered column to a photo body. Host POSTs
  // an image-poi with map_poi_id set, then calls overlays.addPOI with both.
  onMatchImagePOI?: (overlay: THREE.Group, u: number, v: number, controlPointId: string) => void;
  // Fired on shift+wheel with the same normalized px-delta the FOV path uses.
  // Routed out so the host module decides what shift-wheel does.
  onShiftWheel?: (deltaPx: number) => void;
  // Fired whenever the "+ POI" arming state flips. Caller updates UI.
  onPoiArmChange?: (armed: boolean) => void;
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
}

export function attachInput({ viewer, overlays, onChange, onPhotoDropped, onAddImagePOI, onMatchImagePOI, onShiftWheel, onPoiArmChange, findColumnAtNDC, onHoveredColumnChange, onPhotoBodyContextMenu }: AttachInputOptions): InputController {
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
  let poiArmed = false;
  // The map-POI column under the cursor (if any). Set by pointermove via the
  // host's findColumnAtNDC. While non-null the next click will create a paired
  // image-POI on the underlying photo, anchored to this column's lat/lng.
  let hoveredColumn: { controlPointId: string; latlng: LatLng } | null = null;

  // Crosshair cursor is on for both +POI arming and column-hover (which is
  // implicit arming for matching).
  function applyArmedCursor(): void {
    canvas.classList.toggle('tool-poi', poiArmed || hoveredColumn !== null);
  }

  function setHoveredColumn(next: { controlPointId: string; latlng: LatLng } | null): void {
    const prevId = hoveredColumn?.controlPointId ?? null;
    const nextId = next?.controlPointId ?? null;
    hoveredColumn = next;
    if (prevId !== nextId) {
      onHoveredColumnChange?.(nextId);
      applyArmedCursor();
    }
  }

  function togglePoiArm(): void {
    poiArmed = !poiArmed;
    applyArmedCursor();
    onPoiArmChange?.(poiArmed);
  }

  function disarmPoi(): void {
    if (!poiArmed) return;
    poiArmed = false;
    applyArmedCursor();
    onPoiArmChange?.(false);
  }

  let batchOpen = false;
  function openBatch(): void { if (!batchOpen) { overlays.beginBatch(); batchOpen = true; } }
  function closeBatch(): void { if (batchOpen) { batchOpen = false; overlays.endBatch(); } }

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
    raycaster.setFromCamera(ndc, camera);
    const hits = raycastOverlays();

    // Open a batch for the entire drag so per-pointermove mutations don't each
    // re-fire the solver / map redraw / bake-dirty cascade. Closed in endDrag.
    openBatch();

    const poiHit = hits.find(h => getRole(h.object) === ROLE_POI);
    const handleHit = hits.find(h => getRole(h.object) === ROLE_HANDLE);
    const bodyHit = hits.find(h => getRole(h.object) === ROLE_BODY);
    const selected = overlays.getSelected();

    // 1. POI hits always start a POI drag, regardless of selection state.
    if (poiHit) {
      const poiMesh = poiHit.object as THREE.Mesh;
      overlays.setSelectedImageMeasurement(poiMesh);
      mode = { type: 'poi-drag', poi: poiMesh };
      viewer.requestRender();
      if (poiArmed) togglePoiArm();
    }
    // 2. "+ POI" armed: click on body adds a POI; miss un-arms and pans.
    // The host POSTs the image-POI then calls overlays.addPOI with the
    // server id; we don't enter poi-drag mode because the mesh doesn't
    // exist yet at click-time.
    else if (poiArmed) {
      if (bodyHit?.uv) {
        const o = bodyHit.object.parent as THREE.Group;
        onAddImagePOI?.(o, bodyHit.uv.x, bodyHit.uv.y);
      }
      mode = { type: 'pan' };
      togglePoiArm();
    }
    // Hovered column + photo body hit → match. Host POSTs an image measurement
    // with control_point_id set then calls overlays.addImageMeasurement.
    else if (hoveredColumn && bodyHit?.uv) {
      const o = bodyHit.object.parent as THREE.Group;
      const col = hoveredColumn;
      onMatchImagePOI?.(o, bodyHit.uv.x, bodyHit.uv.y, col.controlPointId);
      // Clear the hover now that the click has been consumed; the cursor
      // hasn't moved yet, but the next pointermove will recompute.
      setHoveredColumn(null);
      mode = { type: 'pan' };
    }
    // 3. Corner handle on the selected photo → resize.
    else if (handleHit && selected && handleHit.object.parent === selected) {
      const center = projectToScreen(selected.position);
      const dx = e.clientX - center.x, dy = e.clientY - center.y;
      mode = { type: 'resize', dist: Math.hypot(dx, dy) || 1, sizeRad: overlayData(selected).sizeRad };
    }
    // 4. Body hit. Edge clicks always select+drag; interior clicks only drag if
    //    the photo is already selected (otherwise treat as click-through).
    else if (bodyHit?.uv) {
      const o = bodyHit.object.parent as THREE.Group;
      if (isOnEdge(bodyHit.uv) || selected === o) {
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
        // Body interior of an inactive photo → click-through; deselect any
        // currently active photo (matches "click off the photo deactivates").
        if (selected) { overlays.setSelected(null); onChange(); }
        mode = { type: 'pan' };
      }
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
    if (!onPhotoBodyContextMenu || mode) return;
    ndcFromEvent(e);
    raycaster.setFromCamera(ndc, camera);
    const bodyHit = raycastOverlays().find(h => getRole(h.object) === ROLE_BODY);
    if (!bodyHit?.uv) return;
    e.preventDefault();
    const o = bodyHit.object.parent as THREE.Group;
    onPhotoBodyContextMenu(o, bodyHit.uv.x, bodyHit.uv.y, e.clientX, e.clientY);
  });

  function endDrag(): void {
    mode = null;
    closeBatch();
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
      const hoverTarget = (bodyHit?.uv && isOnEdge(bodyHit.uv))
        ? bodyHit.object.parent as THREE.Group
        : null;
      if (overlays.setHovered(hoverTarget)) viewer.requestRender();
      return;
    }
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
    if (e.key === 'Backspace' || e.key === 'Delete') {
      // POI selection takes priority: a selected POI (photo-attached OR
      // standalone map-POI) is the more specific target the user is acting
      // on (vs the photo it sits on). deleteSelectedMeasurement handles both kinds.
      if (overlays.getSelectedImageMeasurement() || overlays.getSelectedMapMeasurement()) {
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

  return { togglePoiArm, disarmPoi };
}
