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
  // downX/downY + moved track tap-vs-drag: a click that releases without
  // crossing TAP_THRESHOLD_PX opens the POI's context menu instead of
  // committing a no-op move (and skips the undo record).
  | { type: 'poi-drag'; poi: THREE.Mesh; downX: number; downY: number; moved: boolean }
  | { type: 'pinch'; startDist: number; startFov: number; p0: PointerPos; p1: PointerPos }
  // Shift-click-drag from one CP marker to another to author a CP-CP
  // constraint. cpAId is the source. hoverCpId is the other CP currently
  // under the cursor (if any) — the host renders a preview line that snaps
  // to that CP's 3D position when set.
  | { type: 'cp-constraint-draw'; cpAId: string; hoverCpId: string | null }
  // Shift-drag on terrain to orbit the camera around the landscape point
  // initially under the cursor. Pivot + math live in the host's
  // onOrbitDrag — input.ts just routes the cumulative pixel deltas.
  | { type: 'orbit' }
  | null;

// Squared px threshold separating a tap (open menu) from a drag (reposition).
const TAP_THRESHOLD_PX2 = 25;

// Touch long-press hold time before we synthesize a contextmenu open. The
// canvas has touch-action: none, so iOS Safari won't fire its own long-press
// contextmenu — we drive it ourselves.
const LONG_PRESS_MS = 500;
// Generous slop for the "is the finger still holding still?" test. Android
// touch reports several pixels of jitter even on a stationary finger, so
// TAP_THRESHOLD_PX2 (5 px) is too tight here and leads to flaky cancellation.
const LONG_PRESS_SLOP_PX2 = 400;

// A click that resolved to a photo body hit, with the uv where the ray
// crossed the photo. The host uses (overlay, u, v) to anchor a new
// observation if the user picks "Add observation here" from a menu opened
// over the photo.
export interface PhotoBodyHit {
  readonly overlay: THREE.Group;
  readonly u: number;
  readonly v: number;
}

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
  // id so the click callback can open the station menu and (optionally)
  // select the station for ray rendering.
  findStationAtNDC?: (ndc: { x: number; y: number }) => { id: string } | null;
  onStationClick?: (id: string, screenX: number, screenY: number) => void;
  // Fired on body / empty-space clicks. Host clears any persistent
  // station selection (camera-observation rays, highlighted cones).
  onDeselectStation?: () => void;
  // Left-click on a control-point dot. The host receives the CP id plus an
  // optional body hit at the same NDC so the menu can offer "add observation
  // here" anchored to the photo behind the marker.
  onCPClick?: (
    controlPointId: string, screenX: number, screenY: number,
    bodyHit: PhotoBodyHit | null,
  ) => void;
  // Hit-test for CP-CP constraint lines at the cursor's NDC. Returns the
  // constraint id if the cursor is within the host's screen-space radius,
  // else null. The host owns the projection math against its drawn-line
  // cache.
  findConstraintAtNDC?: (ndc: { x: number; y: number }) => { constraintId: string } | null;
  // Plain-click on an existing constraint line. Host opens an edit / delete
  // modal for the constraint.
  onConstraintClick?: (constraintId: string, screenX: number, screenY: number) => void;
  // Shift-click-drag completed on a second CP marker. Host posts the
  // constraint and opens the type picker. Cancels (no callback) when the
  // pointer releases anywhere else.
  onCreateCPConstraint?: (cpAId: string, cpBId: string, screenX: number, screenY: number) => void;
  // Live preview during the constraint draw. cpAId is the source; cpBId is
  // the CP currently under the cursor (or null). Host renders a 3D preview
  // line; passing both ids null clears the preview.
  onCPConstraintDrawPreview?: (cpAId: string | null, cpBId: string | null) => void;
  // Shift-drag on empty space (no overlay hit) tries to anchor an orbit
  // gesture to the landscape point under the cursor. Host raycasts the
  // terrain and stashes the pivot; returning false falls through to the
  // pan path. Subsequent pointermoves call onOrbitDrag with the
  // pixel-delta since the last move; pointerup calls onOrbitEnd.
  onOrbitStart?: (ndc: { x: number; y: number }) => boolean;
  onOrbitDrag?: (dx: number, dy: number) => void;
  onOrbitEnd?: () => void;
  // Records before/after snapshots for gesture-end mutations and applies
  // them on Cmd/Ctrl+Z. Optional for the index page where attachInput
  // still runs but no overlays are mutated.
  undoManager?: UndoManager;
}

export function attachInput({ viewer, overlays, onChange, onPhotoDropped, onShiftWheel, findColumnAtNDC, onHoveredColumnChange, onPhotoBodyContextMenu, onImagePOIContextMenu, findStationAtNDC, onStationClick, onDeselectStation, onCPClick, findConstraintAtNDC, onConstraintClick, onCreateCPConstraint, onCPConstraintDrawPreview, onOrbitStart, onOrbitDrag, onOrbitEnd, undoManager }: AttachInputOptions): void {
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
  let longPressTimer: number | null = null;
  let longPressX = 0, longPressY = 0;
  function cancelLongPress(): void {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }
  // Returns true if a menu was opened.
  function openContextMenuFromHits(clientX: number, clientY: number): boolean {
    ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycastOverlays();
    const poiHit = hits.find(h => getRole(h.object) === ROLE_POI);
    if (poiHit && onImagePOIContextMenu) {
      onImagePOIContextMenu(poiHit.object as THREE.Mesh, clientX, clientY);
      return true;
    }
    const bodyHit = hits.find(h => getRole(h.object) === ROLE_BODY);
    if (bodyHit?.uv && onPhotoBodyContextMenu) {
      onPhotoBodyContextMenu(
        bodyHit.object.parent as THREE.Group, bodyHit.uv.x, bodyHit.uv.y, clientX, clientY,
      );
      return true;
    }
    return false;
  }
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

  // Update photo + reticule hover together. Both stores must always be
  // notified (clearing one without the other leaves a stale highlight); the
  // ||-fold here is just to amortize a single requestRender.
  function applyHover(photo: THREE.Group | null, poi: THREE.Mesh | null): void {
    const a = overlays.photos.setHovered(photo);
    const b = overlays.measurements.setHovered(poi);
    if (a || b) viewer.requestRender();
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

    // CP-marker click. Two cases:
    //   • shift + CP marker → enter CP-CP constraint draw mode. The drag
    //     ends on a second CP (creates) or anywhere else (cancels).
    //   • plain click + CP marker → open the CP menu. Skipped when a POI
    //     sits at the same NDC; clicking an existing observation should
    //     take priority over the CP marker behind it.
    const earlyPoiHit = hits.find(h => getRole(h.object) === ROLE_POI);
    if (!earlyPoiHit) {
      const cpHit = findColumnAtNDC?.({ x: ndc.x, y: ndc.y }) ?? null;
      if (cpHit && e.shiftKey && onCreateCPConstraint) {
        e.stopPropagation();
        mode = { type: 'cp-constraint-draw', cpAId: cpHit.controlPointId, hoverCpId: null };
        canvas.setPointerCapture(e.pointerId);
        onCPConstraintDrawPreview?.(cpHit.controlPointId, null);
        return;
      }
      if (cpHit && onCPClick) {
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

    // Constraint-line click → open the edit/delete modal. Tested before
    // the body-hit / empty-space pan branch so a click on the line beats
    // a pan on the canvas behind it.
    if (!earlyPoiHit && onConstraintClick) {
      const conHit = findConstraintAtNDC?.({ x: ndc.x, y: ndc.y }) ?? null;
      if (conHit) {
        e.stopPropagation();
        pointers.delete(e.pointerId);
        onConstraintClick(conHit.constraintId, e.clientX, e.clientY);
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
    const selected = overlays.photos.getSelected();

    // 1. POI hits arm a tap-or-drag gesture. A pure tap (release within
    //    TAP_THRESHOLD_PX) opens the unified CP menu; once the cursor moves
    //    past the threshold, subsequent pointermoves drag the reticule.
    if (poiHit) {
      const poiMesh = poiHit.object as THREE.Mesh;
      overlays.measurements.setSelected(poiMesh);
      capturePoi(poiMesh);
      mode = { type: 'poi-drag', poi: poiMesh, downX: e.clientX, downY: e.clientY, moved: false };
      viewer.requestRender();
    }
    else {
      // Any non-POI click drops the reticule/CP highlight. The notifySelection
      // hook fans out to viewer.requestRender + refreshControlPointColumns, so
      // the marker repaints blue and the HUD label hides.
      if (overlays.measurements.getSelected()) {
        overlays.measurements.setSelected(null);
      }
      // 3a. Rotate handle on the selected photo → roll about photo center.
      if (rotateHandleHit && selected && rotateHandleHit.object.parent === selected) {
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
        if (raycaster.ray.intersectSphere(overlays.photos.overlaySphere, hit)) {
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
        if (selected !== o) { overlays.photos.setSelected(o); onChange(); }
        onDeselectStation?.();
        mode = { type: 'pan' };
      }
      // 5. Shift-drag on empty space → orbit around the landscape point
      //    under the cursor. Falls through to pan if no terrain hit.
      else if (e.shiftKey && onOrbitStart?.({ x: ndc.x, y: ndc.y })) {
        if (selected) { overlays.photos.setSelected(null); onChange(); }
        onDeselectStation?.();
        mode = { type: 'orbit' };
      }
      // 6. Empty space → deselect the photo and any selected station, then pan.
      else {
        if (selected) { overlays.photos.setSelected(null); onChange(); }
        onDeselectStation?.();
        mode = { type: 'pan' };
      }
    }
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);

    // Touch/pen lacks right-click; synthesize contextmenu via long-press. A
    // pre-existing pinch (size > 1) cancels the timer below.
    cancelLongPress();
    if (e.pointerType !== 'mouse' && pointers.size === 1) {
      longPressX = e.clientX; longPressY = e.clientY;
      const x = longPressX, y = longPressY;
      const pid = e.pointerId;
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        if (!openContextMenuFromHits(x, y)) return;
        // Treat the long-press as ending the gesture: a missed pointerup
        // (Android Chrome can drop captured-pointer events when DOM mutates
        // under the finger) would otherwise leave this pointer in the Map,
        // making the next pointerdown look like a pinch (size === 2).
        closeBatch();
        gestureBefore = null;
        mode = null;
        pointers.delete(pid);
        if (canvas.hasPointerCapture(pid)) canvas.releasePointerCapture(pid);
      }, LONG_PRESS_MS);
    }
  });

  canvas.addEventListener('contextmenu', (e: MouseEvent) => {
    if (mode) return;
    if (openContextMenuFromHits(e.clientX, e.clientY)) e.preventDefault();
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
    cancelLongPress();
    // Smooth handoff: when a pinch ends with one finger still down, slide
    // into pan so the user can continue dragging without re-tapping.
    if (mode?.type === 'pinch' && pointers.size === 1) {
      const [remaining] = [...pointers.values()] as [PointerPos];
      mode = { type: 'pan' };
      lastX = remaining.x; lastY = remaining.y;
      return;
    }
    if (pointers.size === 0) {
      // Tap on a reticule (no drag motion) → open the CP menu and skip the
      // would-be no-op poi-move undo record.
      if (mode?.type === 'poi-drag' && !mode.moved) {
        const poi = mode.poi;
        gestureBefore = null;
        onImagePOIContextMenu?.(poi, e.clientX, e.clientY);
      }
      // Constraint draw release: if we ended on a different CP, fire the
      // create callback; otherwise just clear the preview and bail.
      if (mode?.type === 'cp-constraint-draw') {
        if (mode.hoverCpId && onCreateCPConstraint) {
          onCreateCPConstraint(mode.cpAId, mode.hoverCpId, e.clientX, e.clientY);
        }
        onCPConstraintDrawPreview?.(null, null);
      }
      if (mode?.type === 'orbit') onOrbitEnd?.();
      endDrag();
    }
  }
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('lostpointercapture', onPointerEnd);
  canvas.addEventListener('pointerleave', () => {
    if (mode) return;
    applyHover(null, null);
    setHoveredColumn(null);
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    const tracked = pointers.get(e.pointerId);
    if (tracked) { tracked.x = e.clientX; tracked.y = e.clientY; }
    if (longPressTimer !== null
      && dist2(e.clientX, e.clientY, longPressX, longPressY) > LONG_PRESS_SLOP_PX2) {
      cancelLongPress();
    }
    if (mode?.type === 'pinch') {
      const before = camera.fov;
      viewer.setFov(mode.startFov * mode.startDist / pinchDist(mode.p0, mode.p1));
      if (camera.fov !== before) onChange();
      return;
    }
    if (!mode) {
      // No drag in progress — update hover affordances. Order of precedence
      // (most specific first) so the cursor targets one thing at a time:
      //   1. CP column / marker → "click here to match."
      //   2. POI reticule       → light up the reticule (and any siblings
      //                           sharing the same CP).
      //   3. Photo edge         → outline the photo for editing.
      ndcFromEvent(e);
      raycaster.setFromCamera(ndc, camera);
      const colHit = findColumnAtNDC?.({ x: ndc.x, y: ndc.y }) ?? null;
      setHoveredColumn(colHit);
      if (colHit) {
        applyHover(null, null);
        return;
      }
      const hits = raycastOverlays();
      const poiHit = hits.find(h => getRole(h.object) === ROLE_POI);
      const bodyHit = !poiHit ? hits.find(h => getRole(h.object) === ROLE_BODY) : undefined;
      applyHover(
        bodyHit ? bodyHit.object.parent as THREE.Group : null,
        poiHit ? poiHit.object as THREE.Mesh : null,
      );
      return;
    }
    switch (mode.type) {
      case 'cp-constraint-draw': {
        ndcFromEvent(e);
        const colHit = findColumnAtNDC?.({ x: ndc.x, y: ndc.y }) ?? null;
        const next = colHit && colHit.controlPointId !== mode.cpAId ? colHit.controlPointId : null;
        if (mode.hoverCpId !== next) {
          mode.hoverCpId = next;
          onCPConstraintDrawPreview?.(mode.cpAId, next);
        }
        break;
      }
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
      case 'orbit': {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        onOrbitDrag?.(dx, dy);
        break;
      }
      case 'move': {
        ndcFromEvent(e);
        raycaster.setFromCamera(ndc, camera);
        if (raycaster.ray.intersectSphere(overlays.photos.overlaySphere, movePoint)) {
          movePoint.normalize().applyQuaternion(mode.offset);
          overlays.photos.moveSelectedTo(movePoint);
          // Mutation is inside the drag batch, so onMutate (which would normally
          // request a render) is queued. Request the render directly instead.
          viewer.requestRender();
        }
        break;
      }
      case 'resize': {
        const selected = overlays.photos.getSelected();
        if (!selected) return;
        const center = projectToScreen(selected.position);
        const dx = e.clientX - center.x, dy = e.clientY - center.y;
        const dist = norm2(dx, dy);
        overlays.photos.resizeSelectedTo(mode.sizeRad * (dist / mode.dist));
        onChange();
        break;
      }
      case 'rotate': {
        // Pointer atan2 with screen-Y-down: a CW pointer sweep gives a positive
        // delta. The overlay's local +Z points away from camera, so o.rotateZ
        // with positive roll appears CCW to the viewer — flip the sign so a CW
        // drag rotates the photo CW.
        const currentAngle = Math.atan2(e.clientY - mode.cy, e.clientX - mode.cx);
        overlays.photos.setSelectedRoll(mode.startRoll - (currentAngle - mode.startAngle));
        viewer.requestRender();
        break;
      }
      case 'poi-drag': {
        if (!mode.moved) {
          const ddx = e.clientX - mode.downX, ddy = e.clientY - mode.downY;
          if (ddx * ddx + ddy * ddy < TAP_THRESHOLD_PX2) break;
          mode.moved = true;
        }
        ndcFromEvent(e);
        raycaster.setFromCamera(ndc, camera);
        // Re-raycast against the POI's parent overlay body to recompute UV.
        const body = overlayData(poiData(mode.poi).parentOverlay).body;
        const hit = raycaster.intersectObject(body)[0];
        if (hit?.uv) {
          overlays.measurements.move(mode.poi, hit.uv.x, hit.uv.y);
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
      if (overlays.measurements.getSelected()) {
        overlays.measurements.deleteSelected();
        endDrag();
        onChange();
      } else if (overlays.photos.getSelected()) {
        overlays.photos.deleteSelected();
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
