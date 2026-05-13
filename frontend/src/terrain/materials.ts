import * as THREE from 'three';

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
  return new THREE.MeshLambertMaterial({ map: texture });
}
