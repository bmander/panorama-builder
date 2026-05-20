// Standalone Solve button. Hidden unless a session is active with pending
// user changes.

import { sessionStore } from './session-store.js';
import { sessionPending } from './session-pending.js';

export interface SolverPanel {
  destroy(): void;
}

export function createSolverPanel(host: HTMLElement, onSolve: () => void): SolverPanel {
  const root = document.createElement('div');
  root.className = 'session-widget';
  root.hidden = true;
  host.appendChild(root);

  const solveBtn = document.createElement('button');
  solveBtn.type = 'button';
  solveBtn.className = 'btn';
  solveBtn.textContent = 'Solve';
  solveBtn.addEventListener('click', () => { onSolve(); });
  root.appendChild(solveBtn);

  function render(): void {
    const sessionActive = sessionStore.current() !== null;
    const { userPending } = sessionPending.get();
    root.hidden = !sessionActive || userPending === 0;
  }

  const offSession = sessionStore.onChange(render);
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
