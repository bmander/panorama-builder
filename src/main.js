import { createViewer } from './viewer.js';
import { createOverlayManager } from './overlay.js';
import { createBaker } from './bake.js';
import { attachInput } from './input.js';
import { createHud, attachViewTabs, attachDownload } from './ui.js';
import { createMapView } from './map.js';

const viewer = createViewer({ container: document.body });

const overlays = createOverlayManager({
  overlaysGroup: viewer.overlaysGroup,
  getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
  onMutate: () => { baker.markDirty(); refreshCones(); },
});

function refreshCones() { mapView.setOverlayCones(overlays.getCones()); }

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
const mapView = createMapView({
  container: document.getElementById('map'),
  onLocationChange: loc => {
    coordsEl.textContent = `lat ${loc.lat.toFixed(5)}  lng ${loc.lng.toFixed(5)}`;
  },
});

attachInput({ viewer, overlays, onChange: () => hud.refresh() });
attachViewTabs({ baker, viewer, hud, mapView });
attachDownload({ baker });

hud.refresh();
viewer.start();
