// Solver widget. Shows the pending counter ("N pending" / "N pending · M
// solver"), a "⚠ N problems ▾" rank-deficiency dropdown populated after a
// solve, and the Solve button. Visible when a session is active with any
// pending work; the Solve button itself is disabled when there's nothing
// new to solve (userPending === 0).

import type { RankDeficientAxis } from './api.js';
import * as api from './api.js';
import { sessionStore } from './session-store.js';
import { sessionPending } from './session-pending.js';
import { renderDeficientAxesList } from './types.js';

export interface SolverPanel {
  destroy(): void;
}

export function createSolverPanel(host: HTMLElement, onSolve: () => void): SolverPanel {
  const root = document.createElement('div');
  root.className = 'session-widget';
  root.hidden = true;
  host.appendChild(root);

  const counter = document.createElement('span');
  counter.className = 'session-widget-counter';
  root.appendChild(counter);

  const pendingEl = document.createElement('span');
  pendingEl.title = 'Edits made since the last solve. The solver has not yet incorporated these.';
  counter.appendChild(pendingEl);

  const separatorEl = document.createTextNode(' · ');
  counter.appendChild(separatorEl);

  const solverEl = document.createElement('span');
  solverEl.title = 'Entity updates from the most recent solve. These are applied when you Save.';
  counter.appendChild(solverEl);

  const problemsBtn = document.createElement('button');
  problemsBtn.type = 'button';
  problemsBtn.className = 'session-widget-problems';
  problemsBtn.hidden = true;
  root.appendChild(problemsBtn);

  const dropdown = document.createElement('div');
  dropdown.className = 'session-widget-dropdown';
  dropdown.hidden = true;
  root.appendChild(dropdown);

  const solveBtn = document.createElement('button');
  solveBtn.type = 'button';
  solveBtn.className = 'btn';
  solveBtn.textContent = 'Solve';
  solveBtn.addEventListener('click', () => { onSolve(); });
  root.appendChild(solveBtn);

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

  // Keyed by (sessionId, solverChanges) so unrelated render() ticks don't
  // refire the network call.
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
    pendingEl.textContent = `${userPending.toString()} pending`;
    const hasSolverChanges = solverChanges !== null;
    separatorEl.nodeValue = hasSolverChanges ? ' · ' : '';
    solverEl.textContent = hasSolverChanges ? `${solverChanges.toString()} solver` : '';
    solveBtn.disabled = userPending === 0;
    void refreshProblems();
  }

  const offSession = sessionStore.onChange(render);
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
