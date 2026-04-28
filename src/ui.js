import * as THREE from 'three';

const deg = r => THREE.MathUtils.radToDeg(r).toFixed(1);

export function createHud(getSnapshot) {
  const el = document.getElementById('hud');
  function refresh() {
    const s = getSnapshot();
    let text = `azimuth ${deg(s.azimuth)}°  altitude ${deg(s.altitude)}°  fov ${s.fov.toFixed(1)}°`;
    if (s.selectedSizeRad != null) text += `  selected ${deg(s.selectedSizeRad)}°`;
    el.textContent = text;
  }
  return {
    refresh,
    setVisible(visible) { el.style.display = visible ? 'block' : 'none'; },
  };
}

export function attachViewTabs({ baker, viewer, hud, mapView }) {
  const flatCanvas = document.getElementById('flat');
  const flatWrap = document.getElementById('flat-wrap');
  const mapWrap = document.getElementById('map-wrap');
  const tabs = {
    '360': document.getElementById('tab-360'),
    flat: document.getElementById('tab-flat'),
    map: document.getElementById('tab-map'),
  };

  function setMode(mode) {
    if (mode === 'flat') baker.paintToCanvas(flatCanvas, baker.bake(2048));
    flatWrap.classList.toggle('show', mode === 'flat');
    mapWrap.classList.toggle('show', mode === 'map');
    viewer.setCanvasVisible(mode === '360');
    hud.setVisible(mode === '360');
    for (const [key, btn] of Object.entries(tabs)) btn.classList.toggle('active', key === mode);
    if (mode === 'map') mapView.onShow();
  }

  for (const [mode, btn] of Object.entries(tabs)) btn.addEventListener('click', () => setMode(mode));
  setMode('360');
}

export function attachDownload({ baker }) {
  document.getElementById('download').addEventListener('click', () => {
    const baked = baker.bake(4096);
    const c = document.createElement('canvas');
    baker.paintToCanvas(c, baked);
    c.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'panorama-composite.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  });
}
