// Migration shim. Workers converting bake.js DELETE this file.
import type * as THREE from 'three';
import type { Baked } from './types.js';

export interface Baker {
  bake(width?: number): Baked;
  paintToCanvas(canvas: HTMLCanvasElement, baked: Baked): void;
  markDirty(): void;
}

export function createBaker(options: {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  setVisualsVisible: (visible: boolean) => void;
}): Baker;
