// Modal owning the delete action for an existing CP surface. There are no
// editable fields today (the surface is immutable on the backend), so the
// modal exists mostly as a confirmation surface for "Delete surface".

import * as api from './api.js';
import { getElement } from './types.js';

export interface CPSurfaceModal {
  open(surfaceId: string): void;
  close(): void;
}

export interface CreateCPSurfaceModalOptions {
  onMutated: () => void;
  onClose?: () => void;
}

export function createCPSurfaceModal(opts: CreateCPSurfaceModalOptions): CPSurfaceModal {
  const modalEl = getElement('cp-surface-modal');
  const closeBtn = getElement<HTMLButtonElement>('cp-surface-close');
  const cancelBtn = getElement<HTMLButtonElement>('cp-surface-cancel');
  const deleteBtn = getElement<HTMLButtonElement>('cp-surface-delete');
  const infoEl = getElement('cp-surface-info');
  let currentId: string | null = null;

  function close(): void {
    modalEl.hidden = true;
    currentId = null;
    deleteBtn.disabled = false;
    opts.onClose?.();
  }
  function open(surfaceId: string): void {
    currentId = surfaceId;
    infoEl.textContent = `Surface ${surfaceId}`;
    deleteBtn.disabled = false;
    modalEl.hidden = false;
  }
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  modalEl.addEventListener('click', e => {
    if (e.target === modalEl) close();
  });
  deleteBtn.addEventListener('click', () => {
    if (!currentId) return;
    if (!confirm('Delete this surface?')) return;
    const id = currentId;
    deleteBtn.disabled = true;
    void api.deleteCPSurface(id)
      .then(() => {
        opts.onMutated();
        close();
      })
      .catch((err: unknown) => {
        deleteBtn.disabled = false;
        console.error('cp-surface delete failed:', err);
        alert('Could not delete the surface.');
      });
  });
  return { open, close };
}
