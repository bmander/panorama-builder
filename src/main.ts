import { createViewer } from './viewer.js';
import { createOverlayManager } from './overlay.js';
import { createBaker } from './bake.js';
import { attachInput } from './input.js';
import { createHud, attachViewTabs, attachDownload, attachToolPalette } from './ui.js';
import { createMapView } from './map.js';
import { solvePose, autoFreeParams } from './solver.js';
import type * as THREE from 'three';
import { getElement, overlayData, poiData } from './types.js';
import type { LatLng, SolverParam } from './types.js';

const viewer = createViewer({ container: document.body });

let isSolving = false;
// Re-entrancy guard around the solver: applyPose triggers onMutate, which would
// otherwise recursively re-enter solveAllPhotos. Used by every code path that
// can request a solve (mutation notify, location change, lock toggle).
function runSolve(): void {
  if (isSolving) return;
  isSolving = true;
  try { solveAllPhotos(); } finally { isSolving = false; }
}

const overlays = createOverlayManager({
  overlaysGroup: viewer.overlaysGroup,
  getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
  onMutate: () => {
    viewer.requestRender();
    baker.markDirty();
    // Skip the map work entirely when the map tab isn't showing — getCones /
    // getPOIs walk every overlay and dirty their world matrices for nothing.
    if (mapView.isVisible()) refreshMapAnnotations();
    runSolve();
  },
});

function refreshMapAnnotations(): void {
  mapView.setOverlayCones(overlays.getCones());
  mapView.setPOIBearings(overlays.getPOIs());
}

const baker = createBaker({
  renderer: viewer.renderer,
  scene: viewer.scene,
  setVisualsVisible: visible => { overlays.setVisualsVisible(visible); },
});

const hud = createHud(() => {
  const { azimuth, altitude } = viewer.getAzAlt();
  const sel = overlays.getSelected();
  return {
    azimuth, altitude,
    fov: viewer.camera.fov,
    selectedSizeRad: sel ? overlayData(sel).sizeRad : null,
  };
});

const coordsEl = getElement('map-coords');
coordsEl.textContent = 'no location set — click map to set';

// User-configurable solver locks. When a parameter is locked, autoFreeParams's
// suggestion is filtered down so the solver leaves it fixed. Locking the camera
// position (camLat + camLng) turns 4+ POI fits into a least-squares solve over
// photoAz/sizeRad only.
const lockedParams = new Set<SolverParam>();
function applyCameraLock(locked: boolean): void {
  if (locked) { lockedParams.add('camLat'); lockedParams.add('camLng'); }
  else { lockedParams.delete('camLat'); lockedParams.delete('camLng'); }
}
const lockCameraEl = getElement<HTMLInputElement>('lock-camera');
applyCameraLock(lockCameraEl.checked);
lockCameraEl.addEventListener('change', () => {
  applyCameraLock(lockCameraEl.checked);
  runSolve();
  // Cover the no-solve-happened case: if zero photos have anchored POIs, the
  // solver was a no-op and onMutate didn't fire. Refresh visuals anyway so the
  // user sees a response to the toggle.
  viewer.requestRender();
  if (mapView.isVisible()) refreshMapAnnotations();
  hud.refresh();
});

// Run the photo-pose solver for every overlay that has anchored POIs. The solver
// adjusts each photo's pose (and, with ≥3 anchors, the shared camera location) so
// each anchored POI's projected ray matches the bearing/depression to its anchor.
function solveAllPhotos(): void {
  const camLoc = mapView.getLocation();
  if (!camLoc) return;
  // Holder object so the closure can record a value TS will see post-call.
  // (TS doesn't narrow `let` mutations through callbacks; a wrapper does.)
  const proposed: { camLoc: LatLng | null } = { camLoc: null };
  overlays.withBatch(() => {
    for (const photo of overlays.listOverlays() as THREE.Group[]) {
      const anchored = (overlayData(photo).pois ?? []).filter(
        p => poiData(p).mapAnchor,
      );
      if (anchored.length === 0) continue;
      const pose = overlays.extractPose(photo, camLoc);
      const result = solvePose({
        pose,
        pois: anchored.map(p => {
          const pd = poiData(p);
          const anchor = pd.mapAnchor!;
          return {
            u: pd.uv.u, v: pd.uv.v,
            anchorLat: anchor.lat, anchorLng: anchor.lng,
          };
        }),
        free: autoFreeParams(anchored.length).filter(p => !lockedParams.has(p)),
      });
      overlays.applyPose(photo, result.pose);
      if (result.cameraMoved) {
        proposed.camLoc = { lat: result.pose.camLat, lng: result.pose.camLng };
      }
    }
  });
  // Apply camera move outside the batch so the map's marker updates after pose writes settle.
  if (proposed.camLoc) mapView.setLocation(proposed.camLoc);
}

const mapView = createMapView({
  container: getElement('map'),
  // Force a refresh when the map tab becomes visible — onMutate skips the
  // refresh while the map is hidden, so the caches may be stale here.
  onShowRefresh: () => { refreshMapAnnotations(); },
  onLocationChange: loc => {
    coordsEl.textContent = `lat ${loc.lat.toFixed(5)}  lng ${loc.lng.toFixed(5)}`;
    runSolve();
  },
  onPOIAnchorClick: (handle, latlng) => {
    overlays.setPOIMapAnchor(handle, latlng);
  },
  onPOIAnchorDragged: (handle, latlng /*, viewerAz */) => {
    overlays.withBatch(() => {
      overlays.setPOIMapAnchor(handle, latlng);
      // Solver runs via onMutate after the batch closes; no per-handle rotate needed.
    });
  },
});

const input = attachInput({ viewer, overlays, onChange: () => { viewer.requestRender(); hud.refresh(); } });
attachViewTabs({ baker, viewer, hud, mapView });
attachDownload({ baker });
attachToolPalette({ input });

hud.refresh();
viewer.start();
