import * as THREE from 'three';

export const PITCH_LIMIT = Math.PI / 2 - 0.01;
export const FOV_MIN = 15;
export const FOV_MAX = 100;

// Atmospheric perspective. We override Three.js's default FogExp2 falloff
// (`exp(-σ² · d²)`, stylistic) with Beer-Lambert (`exp(-σ · d)`, the actual
// physics of a uniform absorbing/scattering medium). With σ = 5e-6 that's
// ~15 % at 33 km, ~38 % at 95 km (Rainier from Seattle), ~63 % at 200 km, and
// ~93 % at 525 km. Beer-Lambert leaves more contrast at distance than the
// standard exp-squared falloff for the same near-haze level. Photos at
// radius 100 m get effectively no fog (~5e-4). HAZE_COLOR matches the
// panorama background grid so distant terrain dissolves into the "sky".
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

function makeGridTexture(): HTMLCanvasElement {
  const W = 2048, H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#e6e6e6';
  ctx.fillRect(0, 0, W, H);
  // Minor lines every 15°.
  ctx.strokeStyle = '#d0d0d0';
  ctx.lineWidth = 1;
  for (let lon = 0; lon <= 360; lon += 15) {
    const x = lon / 360 * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let lat = -90; lat <= 90; lat += 15) {
    const y = (90 - lat) / 180 * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  // Major lines every 90° + equator.
  ctx.strokeStyle = '#a0a0a0';
  ctx.lineWidth = 2;
  for (let lon = 0; lon <= 360; lon += 90) {
    const x = lon / 360 * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

  // Compass rose on the floor (cardinal labels at altitude −75°).
  // Equirect u mapping (Three.js convention u = atan2(z, x)/(2π) + 0.5):
  //   N (-Z) → u=0.25, E (+X) → u=0.5, S (+Z) → u=0.75, W (-X) → u=0/1.
  ctx.fillStyle = '#888';
  ctx.font = 'bold 90px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const yLabel = (90 - (-75)) / 180 * H;
  for (const [label, u] of [['N', 0.25], ['E', 0.5], ['S', 0.75], ['W', 0]] as const) {
    ctx.fillText(label, u * W, yLabel);
  }
  ctx.fillText('W', W, yLabel); // wraparound copy so W at u=0 isn't half-clipped

  return canvas;
}

export function createViewer({ container }: { container: HTMLElement }): Viewer {
  // preserveDrawingBuffer prevents the WebGL spec's implicit clear after each
  // composite — required so dirty-driven rendering doesn't flash an empty canvas
  // on frames where renderer.render() is skipped.
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.domElement.id = 'view';
  container.appendChild(renderer.domElement);

  // far is bumped beyond the natural overlay-sphere radius so the outermost
  // terrain LOD ring (which reaches ~525 km at lat 47.6, larger nearer the
  // equator) renders unclipped.
  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000000);
  camera.rotation.order = 'YXZ';

  const baseTex = new THREE.CanvasTexture(makeGridTexture());
  baseTex.mapping = THREE.EquirectangularReflectionMapping;
  baseTex.colorSpace = THREE.SRGBColorSpace;
  baseTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = baseTex;
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
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
      altitude = THREE.MathUtils.clamp(alt, -PITCH_LIMIT, PITCH_LIMIT);
      dirty = true;
    },
    setFov(fov: number) {
      camera.fov = THREE.MathUtils.clamp(fov, FOV_MIN, FOV_MAX);
      camera.updateProjectionMatrix();
      dirty = true;
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
