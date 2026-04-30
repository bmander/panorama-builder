import * as THREE from 'three';
import { getElement } from './types.js';
import type { AzAltSnapshot } from './types.js';
import type { Baker } from './bake.js';
import type { MapView } from './map.js';
import type { Viewer } from './viewer.js';

export interface Hud {
  refresh(): void;
  setVisible(visible: boolean): void;
}

const deg = (r: number): string => THREE.MathUtils.radToDeg(r).toFixed(1);

export function createHud(getSnapshot: () => AzAltSnapshot): Hud {
  const el = getElement('hud');
  function refresh(): void {
    const s = getSnapshot();
    let text = `azimuth ${deg(s.azimuth)}°  altitude ${deg(s.altitude)}°  fov ${s.fov.toFixed(1)}°  height ${s.cameraHeight.toFixed(1)} m`;
    if (s.selectedSizeRad != null) text += `  selected ${deg(s.selectedSizeRad)}°`;
    el.textContent = text;
  }
  return {
    refresh,
    setVisible(visible: boolean): void { el.style.display = visible ? 'block' : 'none'; },
  };
}

export type ViewMode = '360' | 'map';

export interface ViewTabs {
  setMode(mode: ViewMode): void;
  getMode(): ViewMode;
  onModeChange(cb: (mode: ViewMode) => void): void;
}

export function attachViewTabs({ viewer, hud, mapView }: {
  viewer: Viewer;
  hud: Hud;
  mapView: MapView;
}): ViewTabs {
  const mapWrap = getElement('map-wrap');
  const tabs: Record<ViewMode, HTMLElement> = {
    '360': getElement('tab-360'),
    map: getElement('tab-map'),
  };

  let current: ViewMode = '360';
  const modeChangeCbs: ((mode: ViewMode) => void)[] = [];

  function setMode(mode: ViewMode): void {
    current = mode;
    mapWrap.classList.toggle('show', mode === 'map');
    viewer.setCanvasVisible(mode === '360');
    hud.setVisible(mode === '360');
    for (const [key, btn] of Object.entries(tabs)) btn.classList.toggle('active', key === mode);
    if (mode === 'map') mapView.onShow();
    else mapView.onHide();
    for (const cb of modeChangeCbs) cb(mode);
  }

  for (const [mode, btn] of Object.entries(tabs)) btn.addEventListener('click', () => { setMode(mode as ViewMode); });
  setMode('360');

  return {
    setMode,
    getMode: () => current,
    onModeChange(cb) { modeChangeCbs.push(cb); },
  };
}

// Trigger a browser file download for the given Blob. The 1-second revoke
// delay gives the browser time to start the download before we drop the URL.
export function triggerDownload(filename: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); }, 1000);
}

export function attachDownload({ baker }: { baker: Baker }): void {
  getElement('download').addEventListener('click', () => {
    const baked = baker.bake(8192);
    const c = document.createElement('canvas');
    baker.paintToCanvas(c, baked);
    c.toBlob(blob => {
      if (blob == null) return;
      triggerDownload('panorama-composite.png', blob);
    });
  });
}
