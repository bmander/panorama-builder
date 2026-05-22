// Session edit/save/abandon widget. Always visible; the three buttons swap
// based on session state:
//   - Edit     shown when no session is active. Clicking it starts one.
//   - Save     shown once a session is active; enabled when a solve has run
//              with no further user changes.
//   - Abandon  shown once a session is active.
//
// The pending counter and the "⚠ N problems ▾" rank-deficiency dropdown
// live on the sibling solver widget (see solver-panel.ts). Save conflicts
// open the #session-conflict-modal block in index.html with a single
// Abandon-session action.

import type { ApiEntityRef } from './api.js';
import * as session from './session.js';
import { sessionStore } from './session-store.js';
import { sessionPending } from './session-pending.js';
import { openSignOffModal } from './signoff-modal.js';
import { fmtRef, getElement } from './types.js';

export interface SessionPanel {
  destroy(): void;
}

export function createSessionPanel(host: HTMLElement): SessionPanel {
  const root = document.createElement('div');
  root.className = 'session-widget';
  host.appendChild(root);

  const editBtn = btn('Edit');
  editBtn.addEventListener('click', () => {
    editBtn.disabled = true;
    sessionStore.ensureStarted().catch((err: unknown) => {
      console.error('start session failed:', err);
      alert('Could not start an edit session — check your connection and try again.');
    }).finally(() => { editBtn.disabled = false; });
  });
  root.appendChild(editBtn);

  const saveBtn = btn('Save');
  saveBtn.addEventListener('click', () => { onSave(); });
  root.appendChild(saveBtn);

  const abandonBtn = btn('Abandon');
  abandonBtn.classList.add('danger');
  abandonBtn.addEventListener('click', () => { void onAbandon(); });
  root.appendChild(abandonBtn);

  function render(): void {
    const sessionActive = sessionStore.current() !== null;
    const { userPending, solverChanges } = sessionPending.get();
    editBtn.hidden = sessionActive;
    saveBtn.hidden = !sessionActive;
    abandonBtn.hidden = !sessionActive;
    saveBtn.disabled = solverChanges === null || userPending !== 0;
  }

  function onSave(): void {
    openSignOffModal({
      ids: {
        modal: 'session-save-modal',
        signoff: 'session-save-signoff',
        description: 'session-save-description',
        confirm: 'session-save-confirm',
        cancel: 'session-save-cancel',
        close: 'session-save-close',
        error: 'session-save-error',
        rankWarning: 'session-save-rank-warning',
        allowUnderdetermined: 'session-save-allow-underdetermined',
      },
      // Reload takes over after success; keep the spinner visible until
      // the new document arrives so the modal can't be re-clicked.
      closeOnSuccess: false,
      submit: async req => {
        await session.merge(req);
        location.reload();
      },
      onConflict: err => { openConflictModal(err.conflicts); },
    });
  }

  async function onAbandon(): Promise<void> {
    if (!confirm('Discard all session changes?')) return;
    await session.abandon();
    location.reload();
  }

  const offSession = sessionStore.onChange(() => {
    if (sessionStore.current() === null) sessionPending.reset();
    render();
  });
  const offPending = sessionPending.onChange(render);
  render();

  return {
    destroy() {
      offSession();
      offPending();
      root.remove();
    },
  };
}

function btn(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = label;
  return b;
}

// --- Conflict modal --------------------------------------------------------

let conflictModalWired = false;

function openConflictModal(conflicts: ApiEntityRef[]): void {
  const modal = getElement('session-conflict-modal');
  const list = getElement('session-conflict-list');
  list.textContent = conflicts.length === 0
    ? 'The server has moved on since this session started.'
    : `Conflicting entities: ${conflicts.map(fmtRef).join(', ')}`;
  if (!conflictModalWired) {
    const closeBtn = getElement<HTMLButtonElement>('session-conflict-close');
    const abandonBtn = getElement<HTMLButtonElement>('session-conflict-abandon');
    closeBtn.addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });
    abandonBtn.addEventListener('click', () => {
      modal.hidden = true;
      session.abandon().then(() => { location.reload(); }, (err: unknown) => {
        console.error('abandon after conflict failed:', err);
        location.reload();
      });
    });
    conflictModalWired = true;
  }
  modal.hidden = false;
}
