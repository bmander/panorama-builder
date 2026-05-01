// Admin modal: a dialog with a single "Delete project" affordance, gated by
// confirm() and a button-disabled latch to prevent double-submit.

import * as api from './api.js';
import { getElement } from './types.js';

export interface AdminModal {
  setVisible(visible: boolean): void;
}

export interface CreateAdminModalOptions {
  getCurrentLocationId: () => string | null;
}

export function createAdminModal({ getCurrentLocationId }: CreateAdminModalOptions): AdminModal {
  const adminBtn = getElement<HTMLButtonElement>('admin-btn');
  const adminModalEl = getElement('admin-modal');
  const adminCloseBtn = getElement<HTMLButtonElement>('admin-close');
  const adminDeleteBtn = getElement<HTMLButtonElement>('admin-delete');

  function open(): void { adminModalEl.hidden = false; }
  function close(): void { adminModalEl.hidden = true; }

  adminBtn.addEventListener('click', open);
  adminCloseBtn.addEventListener('click', close);
  adminModalEl.addEventListener('click', e => {
    if (e.target === adminModalEl) close();
  });
  adminDeleteBtn.addEventListener('click', () => {
    const id = getCurrentLocationId();
    if (!id) return;
    if (!confirm('Delete this project? Photos, POIs, and matches will be removed permanently.')) return;
    adminDeleteBtn.disabled = true;
    void api.deleteLocation(id)
      .then(() => { location.assign('/'); })
      .catch((err: unknown) => {
        adminDeleteBtn.disabled = false;
        console.error('delete project failed:', err);
        alert('Could not delete the project.');
      });
  });

  return {
    setVisible(visible) { adminBtn.hidden = !visible; },
  };
}
