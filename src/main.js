import { createViewer } from './viewer.js';
import { createOverlayManager } from './overlay.js';
import { createBaker } from './bake.js';
import { attachInput } from './input.js';
import { createHud, attachFlatToggle, attachDownload } from './ui.js';

const viewer = createViewer({ panoramaUrl: 'panorama.png', container: document.body });

const overlays = createOverlayManager({
  overlaysGroup: viewer.overlaysGroup,
  getAnisotropy: () => viewer.renderer.capabilities.getMaxAnisotropy(),
});

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

attachInput({ viewer, overlays, onChange: () => hud.refresh() });
attachFlatToggle({ baker, viewer, hud });
attachDownload({ baker });

hud.refresh();
viewer.start();
