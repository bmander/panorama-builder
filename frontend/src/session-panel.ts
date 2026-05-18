// Solver-aware session widget. Hidden when no session is active. When a
// session exists it shows a counter ("N pending" / "N pending · M solver")
// and three buttons:
//   - Solve   enabled when there are user-pending changes
//   - Save    enabled when a solve has run with no further user changes
//   - Abandon always enabled while the widget is shown
//
// Save conflicts open the #session-conflict-modal block in index.html with a
// single Abandon-session action.

import type { ApiEntityRef, RankDeficientAxis } from './api.js';
import * as api from './api.js';
import * as session from './session.js';
import { sessionStore } from './session-store.js';
import { sessionPending } from './session-pending.js';
import { openSignOffModal } from './signoff-modal.js';
import { fmtRef, getElement, renderDeficientAxesList } from './types.js';

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

  // "N problems ▾" — toggles the dropdown listing the per-entity flagged
  // axes the merge gate would block on. Populated by refreshProblems() after
  // a solve, cleared on session change.
  const problemsBtn = document.createElement('button');
  problemsBtn.type = 'button';
  problemsBtn.className = 'session-widget-problems';
  problemsBtn.hidden = true;
  root.appendChild(problemsBtn);

  const dropdown = document.createElement('div');
  dropdown.className = 'session-widget-dropdown';
  dropdown.hidden = true;
  root.appendChild(dropdown);

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

  let problems: readonly RankDeficientAxis[] = [];
  let lastFetchKey = '';

  problemsBtn.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  const outsideClickHandler = (e: MouseEvent): void => {
    if (dropdown.hidden) return;
    if (e.target instanceof Node && root.contains(e.target)) return;
    dropdown.hidden = true;
  };
  document.addEventListener('click', outsideClickHandler);

  function renderDropdown(): void {
    dropdown.replaceChildren();
    if (problems.length === 0) {
      dropdown.textContent = '(no problems)';
      return;
    }
    dropdown.append(renderDeficientAxesList(problems));
  }

  // refreshProblems hits /sessions/{id}/rank-deficient and caches the
  // result. Keyed by (sessionId, solverChanges) so it doesn't refire on
  // unrelated render() ticks.
  async function refreshProblems(): Promise<void> {
    const id = sessionStore.current();
    const { solverChanges } = sessionPending.get();
    const key = id === null ? '' : `${id}|${solverChanges ?? 'none'}`;
    if (key === lastFetchKey) return;
    lastFetchKey = key;
    if (id === null || solverChanges === null) {
      problems = [];
      renderProblemsButton();
      return;
    }
    try {
      problems = await api.getSessionRankDeficient(id);
    } catch (err) {
      console.error('rank-deficient fetch failed:', err);
      problems = [];
    }
    renderProblemsButton();
    renderDropdown();
  }

  function renderProblemsButton(): void {
    const n = problems.length;
    if (n === 0) {
      problemsBtn.hidden = true;
      dropdown.hidden = true;
      return;
    }
    problemsBtn.hidden = false;
    problemsBtn.textContent = `⚠ ${n.toString()} problem${n === 1 ? '' : 's'} ▾`;
  }

  function render(): void {
    const sessionActive = sessionStore.current() !== null;
    const { userPending, solverChanges } = sessionPending.get();
    const hasWork = userPending > 0 || solverChanges !== null;
    if (!sessionActive || !hasWork) {
      root.hidden = true;
      problems = [];
      lastFetchKey = '';
      renderProblemsButton();
      return;
    }
    root.hidden = false;
    counter.textContent = solverChanges === null
      ? `${userPending.toString()} pending`
      : `${userPending.toString()} pending · ${solverChanges.toString()} solver`;
    solveBtn.disabled = userPending === 0;
    saveBtn.disabled = solverChanges === null || userPending !== 0;
    void refreshProblems();
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
      document.removeEventListener('click', outsideClickHandler);
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
