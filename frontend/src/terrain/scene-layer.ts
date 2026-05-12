import * as THREE from 'three';
import { sunDirection } from '../solar.js';
import type { RingSpec } from './geometry.js';
import { makeTerrainMaterial, type TerrainMaterialMode } from './materials.js';

const DIR_LIGHT_INTENSITY = 2.5;
const AMBIENT_LIGHT_INTENSITY = 0.7;
// Far enough that direction is the only thing that matters; lambert ignores
// magnitude but Three.js still uses the position vector to build the direction.
const DIR_LIGHT_DISTANCE = 1000;

export interface TerrainRingMesh {
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  spec: RingSpec;
}

export interface TerrainSceneLayer {
  setGroupPosition(x: number, y: number, z: number): void;
  attachRing(
    ring: { spec: RingSpec; geometry: THREE.BufferGeometry; texture: THREE.Texture },
    mode: TerrainMaterialMode,
  ): void;
  clear(): void;
  swapMaterials(mode: TerrainMaterialMode): void;
  setVisible(visible: boolean): void;
  setSunDirection(az: number, alt: number): void;
  ringCount(): number;
}

export function createTerrainSceneLayer(
  { scene }: { scene: THREE.Scene },
): TerrainSceneLayer {
  // All ring meshes ride on this group. group.position carries both the
  // camera-height y-offset and the camera-vs-builtLocation x/z translation.
  const terrainGroup = new THREE.Group();
  scene.add(terrainGroup);

  let rings: TerrainRingMesh[] = [];

  // MeshBasicMaterial (wireframe + photo overlays) ignores lights, so leaving
  // them on permanently is harmless — eager creation simplifies the orchestrator.
  const dirLight = new THREE.DirectionalLight(0xffffff, DIR_LIGHT_INTENSITY);
  scene.add(dirLight);
  scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_LIGHT_INTENSITY));

  function applySunDirection(az: number, alt: number): void {
    const d = sunDirection(az, alt);
    dirLight.position.set(d.x * DIR_LIGHT_DISTANCE, d.y * DIR_LIGHT_DISTANCE, d.z * DIR_LIGHT_DISTANCE);
    // Below-horizon: kill direct light so only ambient remains. Otherwise the
    // sun illuminates the underside of terrain, which looks like moonlight.
    dirLight.intensity = alt > 0 ? DIR_LIGHT_INTENSITY : 0;
  }
  // Sensible default until the caller pushes a real direction: noon-south.
  applySunDirection(Math.PI, Math.PI / 4);

  return {
    setGroupPosition(x, y, z) {
      terrainGroup.position.set(x, y, z);
    },
    attachRing({ spec, geometry, texture }, mode) {
      const mesh = new THREE.Mesh(geometry, makeTerrainMaterial(mode, texture));
      mesh.frustumCulled = false; // bounding sphere is huge; we always want it on screen
      // Always draw before photo overlays (which use depthTest:false to stay on
      // top regardless of whether they physically intersect terrain).
      mesh.renderOrder = -1;
      terrainGroup.add(mesh);
      rings.push({ mesh, texture, spec });
    },
    clear() {
      for (const r of rings) {
        terrainGroup.remove(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        r.texture.dispose();
      }
      rings = [];
    },
    swapMaterials(mode) {
      for (const r of rings) {
        const old = r.mesh.material as THREE.Material;
        r.mesh.material = makeTerrainMaterial(mode, r.texture);
        old.dispose();
      }
    },
    setVisible(visible) {
      for (const r of rings) r.mesh.visible = visible;
    },
    setSunDirection: applySunDirection,
    ringCount: () => rings.length,
  };
}
