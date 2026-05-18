// Attaches pointer-driven drag-by-header to a floating dialog. On first
// drag the panel switches from right/left-anchored CSS to left/top so
// it locks to a viewport-relative point. Clamps the header to stay at
// least 40px on-screen so the user can always grab it again.

export function attachDrag(header: HTMLElement, panel: HTMLElement): void {
  let pointerId: number | null = null;
  let dx = 0, dy = 0;

  header.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const rect = panel.getBoundingClientRect();
    dx = e.clientX - rect.left;
    dy = e.clientY - rect.top;
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    header.classList.add('dragging');
    pointerId = e.pointerId;
    header.setPointerCapture(e.pointerId);
  });

  header.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const w = panel.offsetWidth;
    const h = header.offsetHeight;
    const minX = -w + 40, maxX = window.innerWidth - 40;
    const minY = 0, maxY = window.innerHeight - h;
    const x = Math.max(minX, Math.min(maxX, e.clientX - dx));
    const y = Math.max(minY, Math.min(maxY, e.clientY - dy));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });

  const end = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    header.classList.remove('dragging');
  };
  header.addEventListener('pointerup', end);
  header.addEventListener('pointercancel', end);
}
