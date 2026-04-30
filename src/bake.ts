import * as THREE from 'three';
import type { Baked } from './types.js';

export interface Baker {
  bake(width?: number): Baked;
  paintToCanvas(canvas: HTMLCanvasElement, baked: Baked): void;
  markDirty(): void;
}

export interface CreateBakerOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  setVisualsVisible: (visible: boolean) => void;
}

export function createBaker({ renderer, scene, setVisualsVisible }: CreateBakerOptions): Baker {
  const cubeRT = new THREE.WebGLCubeRenderTarget(1024);
  // Far matches viewer.ts's perspective camera so the cube render captures the
  // outermost terrain ring (~525 km at lat 47.6, larger nearer the equator).
  const cubeCam = new THREE.CubeCamera(0.1, 1000000, cubeRT);
  cubeCam.position.set(0, 0, 0);

  const equirectScene = new THREE.Scene();
  const equirectCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const equirectMat = new THREE.ShaderMaterial({
    uniforms: { cubemap: { value: cubeRT.texture } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
    `,
    fragmentShader: `
      precision highp float;
      uniform samplerCube cubemap;
      varying vec2 vUv;
      const float PI = 3.14159265359;
      void main() {
        float lon = (vUv.x - 0.5) * 2.0 * PI;
        float lat = (vUv.y - 0.5) * PI;
        float clat = cos(lat);
        vec3 dir = vec3(cos(lon) * clat, sin(lat), sin(lon) * clat);
        vec4 c = textureCube(cubemap, dir);
        // Linear -> approximate sRGB for downstream display/PNG.
        gl_FragColor = vec4(pow(c.rgb, vec3(1.0 / 2.2)), c.a);
      }
    `,
  });
  equirectScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), equirectMat));
  const equirectRT = new THREE.WebGLRenderTarget(2048, 1024);

  let lastBake: Baked | null = null;
  let dirty = true;

  function bake(width = 2048): Baked {
    if (!dirty && lastBake?.width === width) return lastBake;
    const height = width / 2;
    // Cube face = width / 4 matches the equirect's per-90° span at the equator,
    // so detail isn't bottlenecked at the cubemap when sampling for hi-res output.
    // Floor at 1024 keeps the small flat-preview path inexpensive.
    const cubeFaceSize = Math.max(1024, Math.ceil(width / 4));
    if (cubeRT.width !== cubeFaceSize) cubeRT.setSize(cubeFaceSize, cubeFaceSize);
    setVisualsVisible(false);
    cubeCam.update(renderer, scene);
    if (equirectRT.width !== width) equirectRT.setSize(width, height);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(equirectRT);
    renderer.render(equirectScene, equirectCam);
    renderer.setRenderTarget(prev);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(equirectRT, 0, 0, width, height, pixels);
    setVisualsVisible(true);
    lastBake = { pixels, width, height };
    dirty = false;
    return lastBake;
  }

  function paintToCanvas(canvas: HTMLCanvasElement, baked: Baked): void {
    canvas.width = baked.width;
    canvas.height = baked.height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(baked.width, baked.height);
    const stride = baked.width * 4;
    // WebGL pixel buffer is bottom-up; flip Y when copying into ImageData.
    for (let y = 0; y < baked.height; y++) {
      const src = (baked.height - 1 - y) * stride;
      img.data.set(baked.pixels.subarray(src, src + stride), y * stride);
    }
    ctx.putImageData(img, 0, 0);
  }

  return { bake, paintToCanvas, markDirty() { dirty = true; } };
}
