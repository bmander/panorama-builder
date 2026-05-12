import { getElement } from './types.js';
import type { AzAltSnapshot } from './types.js';
import type { Baker } from './bake.js';
import { radToDeg } from './mathx.js';

export interface Hud {
  refresh(): void;
  setVisible(visible: boolean): void;
}

const deg = (r: number): string => radToDeg(r).toFixed(1);

const pad2 = (n: number): string => String(n).padStart(2, '0');

// Format an angle (radians) in DMS, dropping leading zero components.
function formatDms(rad: number): string {
  const totalSec = radToDeg(rad) * 3600;
  const d = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec - d * 3600) / 60);
  const s = totalSec - d * 3600 - m * 60;
  if (d > 0) return `${d}°${pad2(m)}'${s.toFixed(2)}"`;
  if (m > 0) return `${m}'${s.toFixed(2)}"`;
  return `${s.toFixed(2)}"`;
}

export function createHud(getSnapshot: () => AzAltSnapshot): Hud {
  const el = getElement('hud');
  function refresh(): void {
    const s = getSnapshot();
    let text = `azimuth ${deg(s.azimuth)}°  altitude ${deg(s.altitude)}°  fov ${s.fov.toFixed(1)}°  elev ${s.cameraMSL.toFixed(1)} m MSL (${s.cameraHeightAboveGround.toFixed(1)} m AGL)`;
    if (s.selectedSizeRad != null) text += `  selected ${deg(s.selectedSizeRad)}°`;
    if (s.selectedRadPerPixel != null) text += `  ${formatDms(s.selectedRadPerPixel)}/px`;
    el.textContent = text;
  }
  return {
    refresh,
    setVisible(visible: boolean): void { el.style.display = visible ? 'block' : 'none'; },
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
