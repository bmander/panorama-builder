// Admin modal: a dialog with a single "Delete station" affordance, gated by
// confirm() and a button-disabled latch to prevent double-submit.

import * as api from './api.js';
import { getElement } from './types.js';

export interface AdminModal {
  setVisible(visible: boolean): void;
}

export interface CreateAdminModalOptions {
  getCurrentStationId: () => string | null;
}

export function createAdminModal({ getCurrentStationId }: CreateAdminModalOptions): AdminModal {
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
    const id = getCurrentStationId();
    if (!id) return;
    if (!confirm('Delete this station? Photos, POIs, and matches will be removed permanently.')) return;
    adminDeleteBtn.disabled = true;
    void api.deleteStation(id)
      .then(() => { location.assign('/'); })
      .catch((err: unknown) => {
        adminDeleteBtn.disabled = false;
        console.error('delete station failed:', err);
        alert('Could not delete the station.');
      });
  });

  return {
    setVisible(visible) { adminBtn.hidden = !visible; },
  };
}
