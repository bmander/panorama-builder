// Session save/abandon widget. Hidden when no session is active or there
// is no pending work. Carries two buttons:
//   - Save    enabled when a solve has run with no further user changes
//   - Abandon always enabled while the widget is shown
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
  root.hidden = true;
  host.appendChild(root);

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
    const hasWork = userPending > 0 || solverChanges !== null;
    if (!sessionActive || !hasWork) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
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
