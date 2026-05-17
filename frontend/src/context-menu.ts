import { getElement } from './types.js';

export interface ContextMenuItem {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ContextMenu {
  open(
    x: number, y: number, items: readonly ContextMenuItem[],
    header?: string, info?: readonly string[],
  ): void;
  close(): void;
}

export function createContextMenu(): ContextMenu {
  const el = getElement('context-menu');

  function close(): void {
    el.hidden = true;
    el.replaceChildren();
  }

  function open(
    x: number, y: number, items: readonly ContextMenuItem[],
    header?: string, info?: readonly string[],
  ): void {
    el.replaceChildren();
    if (header !== undefined) {
      const h = document.createElement('div');
      h.className = 'header';
      h.textContent = header;
      el.appendChild(h);
    }
    if (info !== undefined && info.length > 0) {
      const wrap = document.createElement('div');
      wrap.className = 'info';
      for (const line of info) {
        const row = document.createElement('div');
        row.textContent = line;
        wrap.appendChild(row);
      }
      el.appendChild(wrap);
    }
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        close();
        item.onClick();
      });
      el.appendChild(btn);
    }
    // Place first so we can measure, then clamp inside the viewport.
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.hidden = false;
    const rect = el.getBoundingClientRect();
    const clampedX = Math.min(x, window.innerWidth - rect.width - 4);
    const clampedY = Math.min(y, window.innerHeight - rect.height - 4);
    el.style.left = `${Math.max(0, clampedX)}px`;
    el.style.top = `${Math.max(0, clampedY)}px`;
  }

  // Outside click / escape closes. Pointerdown so the close fires before any
  // other click handler — otherwise the click that triggered the close would
  // still see the menu in front of its target.
  document.addEventListener('pointerdown', e => {
    if (el.hidden) return;
    if (e.target instanceof Node && el.contains(e.target)) return;
    close();
  });
  document.addEventListener('keydown', e => {
    if (!el.hidden && e.key === 'Escape') close();
  });

  return { open, close };
}
