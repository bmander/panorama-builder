import * as THREE from 'three';

export const PITCH_LIMIT = Math.PI / 2 - 0.01;
export const FOV_MIN = 15;
export const FOV_MAX = 100;

export function createViewer({ panoramaUrl, container }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.domElement.id = 'view';
  container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
  camera.rotation.order = 'YXZ';

  const baseTex = new THREE.TextureLoader().load(panoramaUrl);
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
