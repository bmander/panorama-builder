import * as THREE from 'three';
import { applySkyHaze } from '../sky.js';

const WIREFRAME_COLOR = 0x88aaff;
const WIREFRAME_OPACITY = 0.35;

export type TerrainMaterialMode = 'wireframe' | 'shaded';

// Adjacent rings cut cleanly on a shared vertex grid — see computeRings'
// invariant. No polygon-offset bias needed.
export function makeTerrainMaterial(
  mode: TerrainMaterialMode,
  texture: THREE.Texture | null,
): THREE.Material {
  if (mode === 'wireframe') {
    return new THREE.MeshBasicMaterial({
      color: WIREFRAME_COLOR,
      wireframe: true,
      transparent: true,
      opacity: WIREFRAME_OPACITY,
      depthWrite: false,
    });
  }
  const mat = new THREE.MeshLambertMaterial({ map: texture });
  // Distant terrain fades into the colour of the sky behind it (warm near
  // the sun, blue away from it) instead of into a flat grey HAZE_COLOR.
  applySkyHaze(mat);
  return mat;
}
