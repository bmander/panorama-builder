// Session-mode solves are preview-only on the server. We rehydrate after a
// solve and overlay result.changes on top of the fetched main+intent view
// so the preview is visible until reload.

import * as api from './api.js';
import { getElement } from './types.js';

export interface SolveActionsDeps {
  getCurrentStationId: () => string;
  rehydrate: (preview?: api.SolveResult) => Promise<void>;
  reportError: (label: string, err: unknown) => void;
}

export function attachSolveActions(deps: SolveActionsDeps): void {
  const { getCurrentStationId, rehydrate, reportError } = deps;

  async function runAndApply(label: string, run: () => Promise<api.SolveResult>): Promise<void> {
    let result: api.SolveResult;
    try {
      result = await run();
    } catch (err) {
      reportError(label, err);
      return;
    }
    if (result.diverged) {
      alert(`${label}: solver made no progress.`);
      return;
    }
    try {
      await rehydrate(result);
    } catch (err) {
      reportError('reload after solve', err);
    }
  }

  const solveStationBtn = getElement<HTMLButtonElement>('solve-station-btn');
  const solveJointBtn = getElement<HTMLButtonElement>('solve-joint-btn');
  solveStationBtn.addEventListener('click', () => {
    solveStationBtn.disabled = true;
    void runAndApply('solve station', () => api.solveStation(getCurrentStationId()))
      .finally(() => { solveStationBtn.disabled = false; });
  });
  solveJointBtn.addEventListener('click', () => {
    solveJointBtn.disabled = true;
    // Joint mode has hundreds of params and est_alt converges slowly. The
    // default cap (30) is too tight here; 200 gets meter-scale alt moves on
    // typical scenes without taking more than a couple seconds.
    void runAndApply('joint solve', () => api.solveJoint({ max_iters: 200 }))
      .finally(() => { solveJointBtn.disabled = false; });
  });
}
