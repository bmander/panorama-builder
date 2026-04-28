// Migration shim. Workers converting viewer.js DELETE this file.
import type * as THREE from 'three';

export const PITCH_LIMIT: number;
export const FOV_MIN: number;
export const FOV_MAX: number;

export interface Viewer {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  overlaysGroup: THREE.Group;
  requestRender(): void;
  getAzAlt(): { azimuth: number; altitude: number };
  setAzAlt(az: number, alt: number): void;
  setCanvasVisible(visible: boolean): void;
  start(): void;
}

export function createViewer(options: { container: HTMLElement }): Viewer;
