// Physically-plausible sky and view-direction-dependent atmospheric haze.
//
// Strategy: render Three.js's built-in Preetham Sky add-on into a 512² cube
// render target whenever a sun-position or look parameter changes, then
// expose that cubemap two ways:
//   1. As `scene.background`. Three.js renders cube backgrounds natively for
//      both the live perspective camera and the bake's CubeCamera, so the
//      same texture lights the canvas and the equirect PNG.
//   2. To materials that opt in via `applySkyHaze`. Their fog chunk samples
//      the cubemap in the world view direction, so distant terrain fades
//      into the colour of the sky it's actually behind instead of a flat
//      grey HAZE_COLOR.
//
// The shader engine itself is Three's `Sky` (BoxGeometry + Preetham frag).
// Sky outputs linear HDR through `<tonemapping_fragment>`, so we scope an
// ACES tone-map + exposure override around the cube-RT bake; the rest of
// the canvas continues to render with its default NoToneMapping.

import * as THREE from 'three';
import { Sky as ThreeSky } from 'three/addons/objects/Sky.js';
import { sunDirection as sunVec } from './solar.js';

// Shared uniform: every applySkyHaze material samples the same probe texture.
// Populated synchronously inside createSky before any applySkyHaze material is
// compiled (station-page.ts creates sky before terrain), so consumers always
// see a real texture.
const skyProbeUniform: { value: THREE.CubeTexture | null } = { value: null };

const HAZE_FRAG_PARS = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  uniform samplerCube skyProbe;
  varying vec3 vSkyHazeWorldPos;
#endif
`;

const HAZE_FRAG = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * vFogDepth);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  vec3 viewDir = normalize(vSkyHazeWorldPos - cameraPosition);
  vec3 hazeColor = textureCube(skyProbe, viewDir).rgb;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor, fogFactor);
#endif
`;

const HAZE_VERT_PARS = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vSkyHazeWorldPos;
#endif
`;

const HAZE_VERT = /* glsl */`
#ifdef USE_FOG
  vFogDepth = -mvPosition.z;
  vSkyHazeWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
#endif
`;

// Bump when the haze shader logic changes so Three doesn't reuse a cached
// program compiled against a previous version of the chunks.
const SKY_HAZE_PROGRAM_KEY = 'sky-haze-v1';

// Patches a material's fog shader chunks so haze colour is sampled from the
// sky probe in the world view direction instead of using the constant fogColor.
// Idempotent: re-calling with the same material just reassigns onBeforeCompile.
export function applySkyHaze(material: THREE.Material): void {
  material.onBeforeCompile = shader => {
    shader.uniforms.skyProbe = skyProbeUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <fog_pars_vertex>', HAZE_VERT_PARS)
      .replace('#include <fog_vertex>', HAZE_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', HAZE_FRAG_PARS)
      .replace('#include <fog_fragment>', HAZE_FRAG);
  };
  // Force the program cache to recompile rather than reusing a fog-less variant.
  material.customProgramCacheKey = () => SKY_HAZE_PROGRAM_KEY;
}

// Runtime-tunable look parameters surfaced as sliders in the settings panel.
// These map 1:1 onto Three.Sky's Preetham uniforms (plus the cloud overlay).
export interface SkyParams {
  turbidity: number;        // 0..20,   default 2  — atmospheric murkiness
  rayleigh: number;         // 0..4,    default 1  — blue-scatter strength
  mieCoefficient: number;   // 0..0.05, default 0.005 — sun glow strength
  mieDirectionalG: number;  // 0..0.99, default 0.8 — Henyey-Greenstein anisotropy
  cloudCoverage: number;    // 0..1,    default 0  — fraction of sky covered by clouds
  cloudDensity: number;     // 0..1,    default 0.4 — opacity of the cloud overlay
  cloudElevation: number;   // 0..1,    default 0.5 — apparent cloud height (0 high/distant, 1 low/close)
}

export const DEFAULT_SKY_PARAMS: SkyParams = {
  turbidity: 2,
  rayleigh: 1,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
  cloudCoverage: 0,
  cloudDensity: 0.4,
  cloudElevation: 0.5,
};

// Tone-mapping the cube-RT bake (Sky emits linear HDR via
// `<tonemapping_fragment>`). Scoped to regenProbe so the canvas keeps its
// default NoToneMapping. Calibrate exposure by eye if the sky reads off.
const PROBE_TONE_MAPPING = THREE.ACESFilmicToneMapping;
const PROBE_TONE_EXPOSURE = 0.5;

export interface Sky {
  setSunDirection(az: number, alt: number): void;
  setParams(partial: Partial<SkyParams>): void;
  beginBake(): void;
  endBake(): void;
}

export interface CreateSkyOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  requestRender: () => void;
}

export function createSky({ scene, renderer, requestRender }: CreateSkyOptions): Sky {
  // Private probe scene: a single Sky mesh that we render through a CubeCamera
  // once per dirty event. Output goes to probeRT, used both as scene.background
  // and as the haze probe sampled by applySkyHaze materials.
  const probeScene = new THREE.Scene();
  const threeSky = new ThreeSky();
  // Sky's vertex shader forces NDC z=1 so the geometric scale only matters for
  // frustum culling. The box half-diagonal at scale 4 is ~3.46, comfortably
  // inside the (0.1, 10) CubeCamera frustum.
  threeSky.scale.setScalar(4);
  probeScene.add(threeSky);

  // Three.Sky's uniforms map types each lookup as possibly undefined under
  // noUncheckedIndexedAccess. The keys are guaranteed by the Sky constructor,
  // so grab them with `!` once and use the typed refs below.
  const u = threeSky.material.uniforms;
  const uTurbidity = u.turbidity!;
  const uRayleigh = u.rayleigh!;
  const uMieCoef = u.mieCoefficient!;
  const uMieG = u.mieDirectionalG!;
  const uCloudCoverage = u.cloudCoverage!;
  const uCloudDensity = u.cloudDensity!;
  const uCloudElevation = u.cloudElevation!;
  const uUp = u.up!;
  const uSunPos = u.sunPosition!;
  uTurbidity.value = DEFAULT_SKY_PARAMS.turbidity;
  uRayleigh.value = DEFAULT_SKY_PARAMS.rayleigh;
  uMieCoef.value = DEFAULT_SKY_PARAMS.mieCoefficient;
  uMieG.value = DEFAULT_SKY_PARAMS.mieDirectionalG;
  uCloudCoverage.value = DEFAULT_SKY_PARAMS.cloudCoverage;
  uCloudDensity.value = DEFAULT_SKY_PARAMS.cloudDensity;
  uCloudElevation.value = DEFAULT_SKY_PARAMS.cloudElevation;
  (uUp.value as THREE.Vector3).set(0, 1, 0);
  // Hide Three.Sky's bright sun disc — sun-marker.ts already renders the
  // visible disc in the main scene, and the haze pipeline samples the cube
  // probe in the view direction, where a hot disc would punch through any
  // foreground that the haze blends.
  u.showSunDisc!.value = 0;

  // 512 gives a smooth direct sky display (visible banding at 64 / 128).
  // ~3 MB at RGBA8; one-time cost on dirty event.
  const probeRT = new THREE.WebGLCubeRenderTarget(512, {
    type: THREE.UnsignedByteType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  // Near/far chosen so the cube cameras' frustums comfortably enclose the
  // scaled Sky box.
  const probeCam = new THREE.CubeCamera(0.1, 10, probeRT);

  // Cubemap shows through directly behind everything else in the main scene,
  // and is what every applySkyHaze material samples for view-direction haze.
  scene.background = probeRT.texture;
  skyProbeUniform.value = probeRT.texture;

  let baking = false;
  let probeDirty = true;
  let lastAz = NaN, lastAlt = NaN;

  function regenProbe(): void {
    if (!probeDirty || baking) return;
    const prevTone = renderer.toneMapping;
    const prevExp = renderer.toneMappingExposure;
    renderer.toneMapping = PROBE_TONE_MAPPING;
    renderer.toneMappingExposure = PROBE_TONE_EXPOSURE;
    probeCam.update(renderer, probeScene);
    renderer.toneMapping = prevTone;
    renderer.toneMappingExposure = prevExp;
    probeDirty = false;
  }
  // Render once synchronously so the first frame already has a valid sky.
  regenProbe();

  return {
    setSunDirection(az, alt) {
      if (az === lastAz && alt === lastAlt) return;
      lastAz = az;
      lastAlt = alt;
      const d = sunVec(az, alt);
      // Sky reads only the direction of sunPosition for scattering geometry
      // (and a y-based fade via exp(-y/450000) that stays ≈ 1 at radius 1000).
      (uSunPos.value as THREE.Vector3).set(d.x, d.y, d.z).multiplyScalar(1000);
      probeDirty = true;
      regenProbe();
      requestRender();
    },
    setParams(partial) {
      let changed = false;
      if (partial.turbidity !== undefined && partial.turbidity !== uTurbidity.value) {
        uTurbidity.value = partial.turbidity;
        changed = true;
      }
      if (partial.rayleigh !== undefined && partial.rayleigh !== uRayleigh.value) {
        uRayleigh.value = partial.rayleigh;
        changed = true;
      }
      if (partial.mieCoefficient !== undefined && partial.mieCoefficient !== uMieCoef.value) {
        uMieCoef.value = partial.mieCoefficient;
        changed = true;
      }
      if (partial.mieDirectionalG !== undefined && partial.mieDirectionalG !== uMieG.value) {
        uMieG.value = partial.mieDirectionalG;
        changed = true;
      }
      if (partial.cloudCoverage !== undefined && partial.cloudCoverage !== uCloudCoverage.value) {
        uCloudCoverage.value = partial.cloudCoverage;
        changed = true;
      }
      if (partial.cloudDensity !== undefined && partial.cloudDensity !== uCloudDensity.value) {
        uCloudDensity.value = partial.cloudDensity;
        changed = true;
      }
      if (partial.cloudElevation !== undefined && partial.cloudElevation !== uCloudElevation.value) {
        uCloudElevation.value = partial.cloudElevation;
        changed = true;
      }
      if (!changed) return;
      probeDirty = true;
      regenProbe();
      requestRender();
    },
    beginBake: () => { baking = true; },
    endBake: () => { baking = false; },
  };
}
