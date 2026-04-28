// Migration shim. Workers converting ui.js DELETE this file.
import type { AzAltSnapshot } from './types.js';
import type { Baker } from './bake.js';
import type { InputController } from './input.js';
import type { MapView } from './map.js';
import type { Viewer } from './viewer.js';

export interface Hud {
  refresh(): void;
  setVisible(visible: boolean): void;
}

export function createHud(getSnapshot: () => AzAltSnapshot): Hud;

export function attachViewTabs(options: {
  baker: Baker;
  viewer: Viewer;
  hud: Hud;
  mapView: MapView;
}): void;

export function attachToolPalette(options: { input: InputController }): void;

export function attachDownload(options: { baker: Baker }): void;
