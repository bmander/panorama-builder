import * as THREE from 'three';
import { TOOL_MOVE, TOOL_POI, type InputController, type Tool } from './input.js';
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
  const el = document.getElementById('hud')!;
  function refresh(): void {
    const s = getSnapshot();
    let text = `azimuth ${deg(s.azimuth)}°  altitude ${deg(s.altitude)}°  fov ${s.fov.toFixed(1)}°`;
    if (s.selectedSizeRad != null) text += `  selected ${deg(s.selectedSizeRad)}°`;
    el.textContent = text;
  }
  return {
    refresh,
    setVisible(visible: boolean): void { el.style.display = visible ? 'block' : 'none'; },
  };
}

type ViewMode = '360' | 'flat' | 'map';

export function attachViewTabs({ baker, viewer, hud, mapView }: {
  baker: Baker;
  viewer: Viewer;
  hud: Hud;
  mapView: MapView;
}): void {
  const flatCanvas = document.getElementById('flat') as HTMLCanvasElement;
  const flatWrap = document.getElementById('flat-wrap')!;
  const mapWrap = document.getElementById('map-wrap')!;
  const tabs: Record<ViewMode, HTMLElement> = {
    '360': document.getElementById('tab-360')!,
    flat: document.getElementById('tab-flat')!,
    map: document.getElementById('tab-map')!,
  };

  function setMode(mode: ViewMode): void {
    if (mode === 'flat') baker.paintToCanvas(flatCanvas, baker.bake(2048));
    flatWrap.classList.toggle('show', mode === 'flat');
    mapWrap.classList.toggle('show', mode === 'map');
    viewer.setCanvasVisible(mode === '360');
    hud.setVisible(mode === '360');
    for (const [key, btn] of Object.entries(tabs)) btn.classList.toggle('active', key === mode);
    if (mode === 'map') mapView.onShow();
    else mapView.onHide();
  }

  for (const [mode, btn] of Object.entries(tabs)) btn.addEventListener('click', () => setMode(mode as ViewMode));
  setMode('360');
}

export function attachToolPalette({ input }: { input: InputController }): void {
  const buttons: Record<Tool, HTMLElement> = {
    [TOOL_MOVE]: document.getElementById('tool-move')!,
    [TOOL_POI]: document.getElementById('tool-poi')!,
  };
  function refresh(): void {
    const cur = input.getTool();
    for (const [name, btn] of Object.entries(buttons)) btn.classList.toggle('active', name === cur);
  }
  for (const [name, btn] of Object.entries(buttons)) {
    btn.addEventListener('click', () => input.setTool(name as Tool));
  }
  input.onToolChange(refresh);
  refresh();
}

export function attachDownload({ baker }: { baker: Baker }): void {
  document.getElementById('download')!.addEventListener('click', () => {
    const baked = baker.bake(8192);
    const c = document.createElement('canvas');
    baker.paintToCanvas(c, baked);
    c.toBlob(blob => {
      if (blob == null) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'panorama-composite.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  });
}
