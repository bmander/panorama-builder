import * as THREE from 'three';
import { clamp } from './mathx.js';

export const PITCH_LIMIT = Math.PI / 2 - 0.01;
export const FOV_MIN = 2;
export const FOV_MAX = 100;
export const DEFAULT_FOV = 75;

// Atmospheric perspective. We override Three.js's default FogExp2 falloff
// (`exp(-σ² · d²)`, stylistic) with Beer-Lambert (`exp(-σ · d)`, the actual
// physics of a uniform absorbing/scattering medium). With σ = 5e-6 that's
// ~15 % at 33 km, ~38 % at 95 km (Rainier from Seattle), ~63 % at 200 km, and
// ~93 % at 525 km. Beer-Lambert leaves more contrast at distance than the
// standard exp-squared falloff for the same near-haze level. Photos at
// radius 100 m get effectively no fog (~5e-4). The fogColor is only the
// fallback for materials that haven't opted into sky.ts's view-direction
// haze via applySkyHaze; for those, this constant still drives haze tint.
const HAZE_COLOR = 0xe6e6e6;
export const HAZE_DENSITY_DEFAULT = 5e-6;
// Slider's 100 % maps here. Wildfire-smoke level — at this density Beer-Lambert
// gives ~63 % haze at 1 km, ~92 % at 5 km, essentially full haze beyond ~10 km.
// Main.ts maps the slider with a cubic curve so the lower end stays usable.
export const HAZE_DENSITY_MAX = 1e-3;

// Override Three.js's fog fragment chunk to use Beer-Lambert (linear in
// distance) instead of the default exp-squared. This affects every material
// in every scene that uses FogExp2; harmless because we only use FogExp2
// once and per-material `fog: false` (e.g. on the sun marker) still opts out.
THREE.ShaderChunk.fog_fragment = `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;

export interface Viewer {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  overlaysGroup: THREE.Group;
  requestRender(): void;
  getAzAlt(): { azimuth: number; altitude: number };
  setAzAlt(az: number, alt: number): void;
  setFov(fov: number): void;
  setFogDensity(density: number): void;
  setCanvasVisible(visible: boolean): void;
  start(): void;
}

export interface CreateViewerOptions {
  container: HTMLElement;
  // Fired after every accepted setFov; the host re-scales any view-size-
  // sensitive overlays (e.g. POIs that should keep a constant pixel size).
  onFovChange?: (fov: number) => void;
}

export function createViewer({ container, onFovChange }: CreateViewerOptions): Viewer {
  // Touch-class GPUs choke on MSAA at retina pixel ratios; downgrade both.
  const isCoarse = matchMedia('(pointer: coarse)').matches;
  const dprCap = isCoarse ? 1.5 : 2;
  const renderer = new THREE.WebGLRenderer({ antialias: !isCoarse });
  renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap));
  renderer.setSize(innerWidth, innerHeight);
  renderer.domElement.id = 'view';
  container.appendChild(renderer.domElement);

  // far is bumped beyond the natural overlay-sphere radius so the outermost
  // terrain LOD ring (which reaches ~525 km at lat 47.6, larger nearer the
  // equator) renders unclipped.
  const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, innerWidth / innerHeight, 0.1, 1000000);
  camera.rotation.order = 'YXZ';

  // Background is owned by sky.ts (full-screen sky-shader quad in scene).
  // Leaving scene.background unset lets the sky quad show through.
  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(HAZE_COLOR, HAZE_DENSITY_DEFAULT);
  scene.fog = fog;
  const overlaysGroup = new THREE.Group();
  scene.add(overlaysGroup);

  let azimuth = 0, altitude = 0;
  let dirty = true;
  let canvasVisible = true;
  const azAltScratch = { azimuth: 0, altitude: 0 };

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap));
    renderer.setSize(innerWidth, innerHeight);
    dirty = true;
  });

  function start(): void {
    function frame(): void {
      if (dirty && canvasVisible) {
        camera.rotation.y = azimuth;
        camera.rotation.x = altitude;
        renderer.render(scene, camera);
        dirty = false;
      }
      requestAnimationFrame(frame);
    }
    frame();
  }

  return {
    renderer, scene, camera, overlaysGroup,
    requestRender() { dirty = true; },
    getAzAlt() {
      azAltScratch.azimuth = azimuth;
      azAltScratch.altitude = altitude;
      return azAltScratch;
    },
    setAzAlt(az: number, alt: number) {
      azimuth = az;
      altitude = clamp(alt, -PITCH_LIMIT, PITCH_LIMIT);
      dirty = true;
    },
    setFov(fov: number) {
      const clamped = clamp(fov, FOV_MIN, FOV_MAX);
      if (camera.fov === clamped) return;
      camera.fov = clamped;
      camera.updateProjectionMatrix();
      dirty = true;
      onFovChange?.(clamped);
    },
    setFogDensity(density: number) {
      const clamped = Math.max(0, density);
      if (fog.density === clamped) return;
      fog.density = clamped;
      dirty = true;
    },
    setCanvasVisible(visible: boolean) {
      canvasVisible = visible;
      renderer.domElement.style.display = visible ? 'block' : 'none';
      if (visible) dirty = true;
    },
    start,
  };
}
