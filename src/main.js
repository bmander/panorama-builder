import { createViewer } from './viewer.js';
import { createOverlayManager } from './overlay.js';
import { createBaker } from './bake.js';
import { attachInput } from './input.js';
import { createHud, attachViewTabs, attachDownload, attachToolPalette } from './ui.js';
import { createMapView } from './map.js';
import { solvePose, autoFreeParams } from './solver.js';

const viewer = createViewer({ container: document.body });

let isSolving = false;
const overlays = createOverlayManager({
  overlaysGroup: viewer.overlaysGroup,
  getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
  onMutate: () => {
    viewer.requestRender();
    baker.markDirty();
    // Skip the map work entirely when the map tab isn't showing — getCones /
    // getPOIs walk every overlay and dirty their world matrices for nothing.
    if (mapView.isVisible()) refreshMapAnnotations();
    // Guard against the recursive notify that fires when the solver writes back poses.
    if (isSolving) return;
    isSolving = true;
    try { solveAllPhotos(); } finally { isSolving = false; }
  },
});

function refreshMapAnnotations() {
  mapView.setOverlayCones(overlays.getCones());
  mapView.setPOIBearings(overlays.getPOIs());
}

const baker = createBaker({
  renderer: viewer.renderer,
  scene: viewer.scene,
  setSelectionVisible: overlays.setVisualsVisible,
});

const hud = createHud(() => {
  const { azimuth, altitude } = viewer.getAzAlt();
  const sel = overlays.getSelected();
  return {
    azimuth, altitude,
    fov: viewer.camera.fov,
    selectedSizeRad: sel ? sel.userData.sizeRad : null,
  };
});

const coordsEl = document.getElementById('map-coords');
coordsEl.textContent = 'no location set — click map to set';

// Run the photo-pose solver for every overlay that has anchored POIs. The solver
// adjusts each photo's pose (and, with ≥3 anchors, the shared camera location) so
// each anchored POI's projected ray matches the bearing/depression to its anchor.
function solveAllPhotos() {
  const camLoc = mapView.getLocation();
  if (!camLoc) return;
  let proposedCamLoc = null;
  overlays.withBatch(() => {
    for (const photo of overlays.listOverlays()) {
      const anchored = (photo.userData.pois || []).filter(p => p.userData.mapAnchor);
      if (anchored.length === 0) continue;
      const pose = overlays.extractPose(photo, camLoc);
      const result = solvePose({
        pose,
        pois: anchored.map(p => ({
          u: p.userData.uv.u, v: p.userData.uv.v,
          anchorLat: p.userData.mapAnchor.lat, anchorLng: p.userData.mapAnchor.lng,
        })),
        free: autoFreeParams(anchored.length),
      });
      overlays.applyPose(photo, result.pose);
      if (result.cameraMoved) proposedCamLoc = { lat: result.pose.camLat, lng: result.pose.camLng };
    }
  });
  // Apply camera move outside the batch so the map's marker updates after pose writes settle.
  if (proposedCamLoc) mapView.setLocation(proposedCamLoc);
}

const mapView = createMapView({
  container: document.getElementById('map'),
  // Force a refresh when the map tab becomes visible — onMutate skips the
  // refresh while the map is hidden, so the caches may be stale here.
  onShowRefresh: () => refreshMapAnnotations(),
  onLocationChange: loc => {
    coordsEl.textContent = `lat ${loc.lat.toFixed(5)}  lng ${loc.lng.toFixed(5)}`;
    if (isSolving) return;
    isSolving = true;
    try { solveAllPhotos(); } finally { isSolving = false; }
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
