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

export function attachFlatToggle({ baker, viewer, hud }) {
  const flatCanvas = document.getElementById('flat');
  const flatWrap = document.getElementById('flat-wrap');
  const toggleBtn = document.getElementById('toggle');
  let showingFlat = false;
  toggleBtn.addEventListener('click', () => {
    showingFlat = !showingFlat;
    if (showingFlat) baker.paintToCanvas(flatCanvas, baker.bake(2048));
    flatWrap.classList.toggle('show', showingFlat);
    viewer.setCanvasVisible(!showingFlat);
    hud.setVisible(!showingFlat);
    toggleBtn.textContent = showingFlat ? '360° view' : 'flat view';
  });
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
