// Solver-aware session widget. Hidden when no session is active. When a
// session exists it shows a counter ("N pending" / "N pending · M solver")
// and three buttons:
//   - Solve   enabled when there are user-pending changes
//   - Save    enabled when a solve has run with no further user changes
//   - Abandon always enabled while the widget is shown
//
// Save conflicts open the #session-conflict-modal block in index.html with a
// single Abandon-session action.

import { SessionConflictError } from './api.js';
import type { ApiEntityRef, ApiMergeRequest } from './api.js';
import { sessionManager } from './session.js';
import { sessionPending } from './session-pending.js';
import { fmtRef, getElement } from './types.js';

export interface SessionPanel {
  destroy(): void;
}

export interface CreateSessionPanelOptions {
  // Click handler for the widget's Solve button. Hosts wire this to whichever
  // solve modal is appropriate for the current view (joint vs. single-station).
  onSolve: () => void;
}

export function createSessionPanel(
  host: HTMLElement,
  options: CreateSessionPanelOptions,
): SessionPanel {
  const root = document.createElement('div');
  root.className = 'session-widget';
  root.hidden = true;
  host.appendChild(root);

  const counter = document.createElement('span');
  counter.className = 'session-widget-counter';
  root.appendChild(counter);

  const solveBtn = btn('Solve');
  solveBtn.addEventListener('click', () => { options.onSolve(); });
  root.appendChild(solveBtn);

  const saveBtn = btn('Save');
  saveBtn.addEventListener('click', () => { onSave(); });
  root.appendChild(saveBtn);

  const abandonBtn = btn('Abandon');
  abandonBtn.classList.add('danger');
  abandonBtn.addEventListener('click', () => { void onAbandon(); });
  root.appendChild(abandonBtn);

  function render(): void {
    const sessionActive = sessionManager.current() !== null;
    if (!sessionActive) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const { userPending, solverChanges } = sessionPending.get();
    counter.textContent = solverChanges === null
      ? `${userPending.toString()} pending`
      : `${userPending.toString()} pending · ${solverChanges.toString()} solver`;
    solveBtn.disabled = userPending === 0;
    saveBtn.disabled = solverChanges === null || userPending !== 0;
  }

  function onSave(): void {
    openSaveModal(async (req) => {
      await sessionManager.merge(req);
      location.reload();
    });
  }

  async function onAbandon(): Promise<void> {
    if (!confirm('Discard all session changes?')) return;
    await sessionManager.abandon();
    location.reload();
  }

  const offSession = sessionManager.onChange(() => {
    if (sessionManager.current() === null) sessionPending.reset();
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

// --- Save modal ------------------------------------------------------------

let saveModalWired = false;
let saveSubmit: ((req: ApiMergeRequest) => Promise<void>) | null = null;

function openSaveModal(submit: (req: ApiMergeRequest) => Promise<void>): void {
  const modal = getElement('session-save-modal');
  const signoffEl = getElement<HTMLInputElement>('session-save-signoff');
  const descriptionEl = getElement<HTMLTextAreaElement>('session-save-description');
  const confirmBtn = getElement<HTMLButtonElement>('session-save-confirm');
  const cancelBtn = getElement<HTMLButtonElement>('session-save-cancel');
  const closeBtn = getElement<HTMLButtonElement>('session-save-close');
  const errorEl = getElement('session-save-error');

  const setLoading = (loading: boolean): void => {
    confirmBtn.classList.toggle('loading', loading);
    confirmBtn.disabled = loading || signoffEl.value.trim() === '';
    cancelBtn.disabled = loading;
    closeBtn.disabled = loading;
    signoffEl.disabled = loading;
    descriptionEl.disabled = loading;
  };

  signoffEl.value = '';
  descriptionEl.value = '';
  errorEl.textContent = '';
  errorEl.hidden = true;
  setLoading(false);
  saveSubmit = submit;

  if (!saveModalWired) {
    const close = (): void => {
      if (confirmBtn.classList.contains('loading')) return;
      modal.hidden = true;
      saveSubmit = null;
    };
    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    signoffEl.addEventListener('input', () => {
      confirmBtn.disabled = signoffEl.value.trim() === '';
    });
    confirmBtn.addEventListener('click', () => {
      const signOff = signoffEl.value.trim();
      if (signOff === '' || !saveSubmit) return;
      const description = descriptionEl.value.trim();
      const req: ApiMergeRequest = description === ''
        ? { sign_off: signOff }
        : { sign_off: signOff, message: description };
      const handler = saveSubmit;
      errorEl.hidden = true;
      errorEl.textContent = '';
      setLoading(true);
      handler(req).then(() => {
        // Success path reloads the page; keep the spinner visible until
        // the new document arrives so the modal can't be re-clicked.
      }, (err: unknown) => {
        setLoading(false);
        if (err instanceof SessionConflictError) {
          modal.hidden = true;
          saveSubmit = null;
          openConflictModal(err.conflicts);
          return;
        }
        console.error('merge failed:', err);
        errorEl.textContent = err instanceof Error ? err.message : String(err);
        errorEl.hidden = false;
      });
    });
    saveModalWired = true;
  }
  modal.hidden = false;
  signoffEl.focus();
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
      sessionManager.abandon().then(() => { location.reload(); }, (err: unknown) => {
        console.error('abandon after conflict failed:', err);
        location.reload();
      });
    });
    conflictModalWired = true;
  }
  modal.hidden = false;
}
