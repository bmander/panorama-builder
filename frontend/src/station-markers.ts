// Other stations rendered as green dots in the 360° photo viewer. Reuses
// the shared dot-layer primitive, so styling (size, alpha, always-on-top
// rules) matches the control-point markers exactly.

import * as THREE from 'three';
import type { LatLng } from './types.js';
import { createDotLayer } from './dot-layer.js';

const STATION_COLOR = 0x40d040;

export interface StationMarker {
  readonly id: string;
  readonly anchor: LatLng;
  readonly altitude: number;
}

export interface StationMarkers {
  update(camLoc: LatLng | null, cameraHeight: number, markers: readonly StationMarker[]): void;
  setVisible(visible: boolean): void;
}

export interface CreateStationMarkersOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

export function createStationMarkers({ scene, requestRender }: CreateStationMarkersOptions): StationMarkers {
  const dots = createDotLayer({ scene, requestRender });
  const color = new THREE.Color(STATION_COLOR);

  return {
    setVisible(visible) { dots.setVisible(visible); },
    update(camLoc, cameraHeight, markers) {
      dots.update(camLoc, cameraHeight, markers.map(m => ({
        anchor: m.anchor, altitude: m.altitude, color,
      })));
    },
  };
}
