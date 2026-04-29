// Visible disc at the sun's sky position. The directional light in terrain.ts
// already uses the same azimuth/altitude to drive shading; this gives the user
// a direct visual readout in the 360° viewer.

import * as THREE from 'three';
import { sunDirection } from './solar.js';

// Within the camera's far plane (1000 km in viewer.ts) and beyond the
// outermost terrain ring (~525 km half-width at lat 47.6). Standard depth
// testing then naturally hides the sun behind any nearer peak.
const SUN_RADIUS_M = 800_000;
const SUN_ANGULAR_DIAMETER_RAD = Math.PI / 180; // 1° — larger than reality (~0.5°) but readable
const SUN_COLOR = 0xfff2cc;

export interface SunMarker {
  setDirection(az: number, alt: number): void;
  setBakeVisible(visible: boolean): void;
}

export interface CreateSunMarkerOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

export function createSunMarker({ scene, requestRender }: CreateSunMarkerOptions): SunMarker {
  const sphereR = SUN_RADIUS_M * Math.sin(SUN_ANGULAR_DIAMETER_RAD / 2);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(sphereR, 24, 16),
    new THREE.MeshBasicMaterial({ color: SUN_COLOR }),
  );
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  let bakeHidden = false;
  let aboveHorizon = false;

  function applyVisibility(): void {
    mesh.visible = aboveHorizon && !bakeHidden;
  }

  return {
    setDirection(az, alt) {
      aboveHorizon = alt > 0;
      if (aboveHorizon) {
        const d = sunDirection(az, alt);
        mesh.position.set(d.x * SUN_RADIUS_M, d.y * SUN_RADIUS_M, d.z * SUN_RADIUS_M);
      }
      applyVisibility();
      requestRender();
    },
    setBakeVisible(visible) {
      bakeHidden = !visible;
      applyVisibility();
    },
  };
}
