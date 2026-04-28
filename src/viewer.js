import * as THREE from 'three';

export const PITCH_LIMIT = Math.PI / 2 - 0.01;
export const FOV_MIN = 15;
export const FOV_MAX = 100;

function makeGridTexture() {
  const W = 2048, H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, W, H);
  // Minor lines every 15°.
  ctx.strokeStyle = '#2c2c2c';
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
  ctx.strokeStyle = '#454545';
  ctx.lineWidth = 2;
  for (let lon = 0; lon <= 360; lon += 90) {
    const x = lon / 360 * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  return canvas;
}

export function createViewer({ container }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.domElement.id = 'view';
  container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
  camera.rotation.order = 'YXZ';

  const baseTex = new THREE.CanvasTexture(makeGridTexture());
  baseTex.mapping = THREE.EquirectangularReflectionMapping;
  baseTex.colorSpace = THREE.SRGBColorSpace;
  baseTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = baseTex;
  const overlaysGroup = new THREE.Group();
  scene.add(overlaysGroup);

  let azimuth = 0, altitude = 0;
  const azAltScratch = { azimuth: 0, altitude: 0 };

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
  });

  function start() {
    function frame() {
      camera.rotation.y = azimuth;
      camera.rotation.x = altitude;
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    }
    frame();
  }

  return {
    renderer, scene, camera, overlaysGroup,
    getAzAlt() {
      azAltScratch.azimuth = azimuth;
      azAltScratch.altitude = altitude;
      return azAltScratch;
    },
    setAzAlt(az, alt) {
      azimuth = az;
      altitude = THREE.MathUtils.clamp(alt, -PITCH_LIMIT, PITCH_LIMIT);
    },
    setCanvasVisible(visible) {
      renderer.domElement.style.display = visible ? 'block' : 'none';
    },
    start,
  };
}
