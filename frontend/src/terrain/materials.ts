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
  const lambert = new THREE.MeshLambertMaterial({
    map: texture,
    side: THREE.DoubleSide,
  });
  // Heightfield normals all point ~up, so distant peaks above the camera
  // render via the back face — and Three.js samples the same UV from both
  // sides, which looks horizontally mirrored to the viewer. Flip UV.x on
  // back-facing fragments so the imagery reads correctly looking up.
  lambert.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec2 _terrainUv = gl_FrontFacing ? vMapUv : vec2(1.0 - vMapUv.x, vMapUv.y);
        vec4 sampledDiffuseColor = texture2D( map, _terrainUv );
        diffuseColor *= sampledDiffuseColor;
      #endif`,
    );
  };
  // Stable cache key so Three.js shares one compiled program across all our
  // ring materials instead of recompiling per instance.
  lambert.customProgramCacheKey = (): string => 'terrain-backface-uv-flip';
  return lambert;
}
