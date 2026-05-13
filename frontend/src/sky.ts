// Physically-plausible sky and view-direction-dependent atmospheric haze.
//
// Strategy: render the (expensive) Rayleigh + Mie raymarch into a 512² cube
// render target whenever the sun moves, then expose that cubemap two ways:
//   1. As `scene.background`. Three.js renders cube backgrounds natively for
//      both the live perspective camera and the bake's CubeCamera, so the
//      same texture lights the canvas and the equirect PNG.
//   2. To materials that opt in via `applySkyHaze`. Their fog chunk samples
//      the cubemap in the world view direction, so distant terrain fades
//      into the colour of the sky it's actually behind instead of a flat
//      grey HAZE_COLOR.
//
// All per-frame cost is a single cubemap lookup. Sun-change cost is one cube
// render (6 face renders × 512² × ~16 primary × 8 light samples), about
// single-digit ms on a typical GPU. Sky parameters are tuned for visual
// plausibility over strict physical accuracy — see the constants below.

import * as THREE from 'three';
import { sunDirection as sunVec } from './solar.js';

const SKY_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  // Bypass projection: emit NDC directly so the quad covers the whole view
  // for any camera (including each face of a CubeCamera). z=1 puts it at
  // the far plane so opaque geometry overdraws it naturally.
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const SKY_FRAG = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform mat4 uInverseProjection;
uniform mat4 uInverseView;
uniform vec3 uSunDirection;

const float PI = 3.14159265358979;
const float EARTH_R = 6371000.0;
const float ATMO_R  = 6471000.0;            // 100 km thick shell
// Rayleigh coefficients tuned for a recognisable blue-vs-orange ratio at
// noon (blue dominates overhead, red survives to the horizon) without the
// blue channel saturating to white through the tone-map.
const vec3  BETA_R  = vec3(5.8e-6, 13.5e-6, 33.1e-6);
// Mie reduced from the textbook 21e-6 — at 21e-6 the forward-scatter halo
// near the sun dominates the rest of the cubemap; 8e-6 gives a soft halo
// without washing out the rest of the sky.
const float BETA_M  = 8e-6;
const float MIE_G   = 0.76;                 // Henyey-Greenstein anisotropy
const float SCALE_R = 8000.0;
const float SCALE_M = 1200.0;
const float SUN_INTENSITY = 22.0;
const int   PRIMARY_STEPS = 16;
const int   LIGHT_STEPS   = 8;

// Returns (tNear, tFar) for the ray ro+t*rd against sphere of radius r centred
// at origin. Returns (-1, -1) when there is no real intersection.
vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(-1.0);
  float s = sqrt(d);
  return vec2(-b - s, -b + s);
}

vec3 atmosphere(vec3 ro, vec3 rd, vec3 sun) {
  vec2 tA = raySphere(ro, rd, ATMO_R);
  if (tA.y < 0.0) return vec3(0.0);
  float t0 = max(tA.x, 0.0);
  // Always integrate the full atmosphere chord — don't stop early at an
  // Earth hit. Below-horizon view rays have short Earth-hit distances (down
  // to a few metres for an observer at sea level), and the resulting jump
  // in integration length across the horizon shows up as a visible dark
  // band in the cubemap right above the visible terrain horizon. Below-
  // horizon directions are covered by the terrain mesh in the live scene
  // anyway, so any over-scattering for those directions doesn't show.
  float t1 = tA.y;

  float dt = (t1 - t0) / float(PRIMARY_STEPS);
  float odR = 0.0, odM = 0.0;
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);

  for (int i = 0; i < PRIMARY_STEPS; i++) {
    vec3 p = ro + rd * (t0 + dt * (float(i) + 0.5));
    float h = max(length(p) - EARTH_R, 0.0);
    float dR = exp(-h / SCALE_R) * dt;
    float dM = exp(-h / SCALE_M) * dt;
    odR += dR;
    odM += dM;

    vec2 tAS = raySphere(p, sun, ATMO_R);
    if (tAS.y <= 0.0) continue;
    vec2 tES = raySphere(p, sun, EARTH_R);
    if (tES.x > 0.0 && tES.x < tAS.y) continue;  // sun is below horizon for p

    float dts = tAS.y / float(LIGHT_STEPS);
    float odRs = 0.0, odMs = 0.0;
    for (int j = 0; j < LIGHT_STEPS; j++) {
      vec3 ps = p + sun * (dts * (float(j) + 0.5));
      float hs = max(length(ps) - EARTH_R, 0.0);
      odRs += exp(-hs / SCALE_R) * dts;
      odMs += exp(-hs / SCALE_M) * dts;
    }
    vec3 tau = BETA_R * (odR + odRs) + BETA_M * 1.1 * (odM + odMs);
    vec3 attn = exp(-tau);
    sumR += attn * dR;
    sumM += attn * dM;
  }

  float mu = dot(rd, sun);
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g2 = MIE_G * MIE_G;
  float pM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) /
             ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * MIE_G * mu, 0.0), 1.5));

  return SUN_INTENSITY * (sumR * BETA_R * pR + sumM * BETA_M * pM);
}

void main() {
  // World-space view ray from inverse projection × inverse view of NDC corners.
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 nearW = uInverseView * uInverseProjection * vec4(ndc, -1.0, 1.0);
  vec4 farW  = uInverseView * uInverseProjection * vec4(ndc,  1.0, 1.0);
  vec3 dir = normalize(farW.xyz / farW.w - nearW.xyz / nearW.w);

  // Observer at sea level on the local-up axis (scene's +Y).
  vec3 origin = vec3(0.0, EARTH_R + 1.0, 0.0);
  vec3 col = atmosphere(origin, dir, normalize(uSunDirection));

  // Luminance-only Reinhard: preserves chromatic saturation that the naive
  // per-channel "col / (col + 1)" would crush (the brightest channel — blue
  // overhead, red at the horizon — gets compressed more than the others, so
  // the sky goes grey instead of staying blue/orange). Output stays in
  // linear space; Three's WebGLRenderer encodes to sRGB on canvas write,
  // and bake.ts's equirect pass handles gamma for the PNG export.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float lumOut = lum / (1.0 + lum);
  col *= lumOut / max(lum, 1e-6);
  gl_FragColor = vec4(col, 1.0);
}
`;

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

export interface Sky {
  setSunDirection(az: number, alt: number): void;
  beginBake(): void;
  endBake(): void;
}

export interface CreateSkyOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  requestRender: () => void;
}

export function createSky({ scene, renderer, requestRender }: CreateSkyOptions): Sky {
  const sunDirVec = new THREE.Vector3(0, 1, 0);

  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uInverseProjection: { value: new THREE.Matrix4() },
      uInverseView: { value: new THREE.Matrix4() },
      uSunDirection: { value: sunDirVec },
    },
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    fog: false,
  });

  // Per-render hook that refreshes the inverse-projection / inverse-view
  // uniforms from whichever camera is drawing this mesh. Lives on the Mesh
  // (not the Material) because Three only fires onBeforeRender at the object
  // level. Critical for correctness during the bake's CubeCamera pass — each
  // of the 6 face cameras has different matrices.
  const invProj = skyMat.uniforms.uInverseProjection!.value as THREE.Matrix4;
  const invView = skyMat.uniforms.uInverseView!.value as THREE.Matrix4;
  const refreshSkyMatrices = (
    _r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera,
  ): void => {
    invProj.copy(camera.projectionMatrixInverse);
    // matrixWorld is the camera-to-world transform = inverse of the view matrix.
    invView.copy(camera.matrixWorld);
  };

  // Single quad in a private scene that we render through a CubeCamera once
  // per sun-change. Output goes to skyProbeRT, which is then used both as
  // scene.background (Three's native cube background path renders for any
  // camera, including bake.ts's CubeCamera) and as the haze probe sampled
  // by applySkyHaze materials.
  const probeScene = new THREE.Scene();
  const probeMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMat);
  probeMesh.frustumCulled = false;
  probeMesh.onBeforeRender = refreshSkyMatrices;
  probeScene.add(probeMesh);

  // 512 gives a smooth direct sky display (visible banding at 64 / 128).
  // ~3 MB at RGBA8; one-time cost on sun-change.
  const probeRT = new THREE.WebGLCubeRenderTarget(512, {
    type: THREE.UnsignedByteType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  // Near/far chosen so the cube cameras' frustums comfortably enclose the
  // unit-radius sky quad (which lives at NDC z=1 regardless of camera).
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
    probeCam.update(renderer, probeScene);
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
      sunDirVec.set(d.x, d.y, d.z);
      probeDirty = true;
      regenProbe();
      requestRender();
    },
    beginBake: () => { baking = true; },
    endBake: () => { baking = false; },
  };
}
