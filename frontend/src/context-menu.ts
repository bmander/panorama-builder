import { getElement } from './types.js';

export interface ContextMenuButtonItem {
  readonly kind?: 'button';
  readonly label: string;
  readonly onClick: () => void;
}

export interface ContextMenuRadioOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface ContextMenuRadioGroup {
  readonly kind: 'radio-group';
  readonly legend: string;
  readonly options: readonly ContextMenuRadioOption[];
  readonly selected: string | null;
  // Fires with the new value, or null when the user clicked the already-
  // selected option (toggle-off semantics).
  readonly onChange: (value: string | null) => void;
}

export type ContextMenuItem = ContextMenuButtonItem | ContextMenuRadioGroup;

export interface ContextMenu {
  open(
    x: number, y: number, items: readonly ContextMenuItem[],
    header?: string, info?: readonly string[],
  ): void;
  close(): void;
}

let radioGroupSeq = 0;

export function createContextMenu(): ContextMenu {
  const el = getElement('context-menu');

  function close(): void {
    el.hidden = true;
    el.replaceChildren();
  }

  function renderRadioGroup(item: ContextMenuRadioGroup): HTMLFieldSetElement {
    const fs = document.createElement('fieldset');
    fs.className = 'radio-group';
    const legend = document.createElement('legend');
    legend.textContent = item.legend;
    fs.appendChild(legend);
    const groupName = `ctx-radio-${++radioGroupSeq}`;
    // Tracks the live selection so a click on the already-selected radio is
    // recognized as a toggle-off — native radios don't fire `change` when
    // the state doesn't move.
    let currentSelected = item.selected;
    for (const opt of item.options) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = groupName;
      input.value = opt.value;
      input.checked = currentSelected === opt.value;
      if (opt.disabled) input.disabled = true;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        if (currentSelected === opt.value) return;
        currentSelected = opt.value;
        item.onChange(opt.value);
      });
      input.addEventListener('click', () => {
        if (input.disabled) return;
        if (currentSelected !== opt.value) return;
        input.checked = false;
        currentSelected = null;
        item.onChange(null);
      });
      const span = document.createElement('span');
      span.textContent = opt.label;
      label.appendChild(input);
      label.appendChild(span);
      fs.appendChild(label);
    }
    return fs;
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
      if (item.kind === 'radio-group') {
        el.appendChild(renderRadioGroup(item));
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        close();
        item.onClick();
      });
      el.appendChild(btn);
    }
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
