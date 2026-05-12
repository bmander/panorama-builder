import * as api from './api.js';
import { getElement } from './types.js';
import { createSolveModal } from './solve-modal.js';

export interface SolveActionsDeps {
  getCurrentStationId: () => string;
  rehydrate: () => Promise<void>;
  reportError: (label: string, err: unknown) => void;
}

export function attachSolveActions(deps: SolveActionsDeps): void {
  const { getCurrentStationId, rehydrate, reportError } = deps;

  const solveModal = createSolveModal({
    onComplete: (result, dryRun) => {
      if (dryRun || result.diverged) return;
      rehydrate().catch((err: unknown) => { reportError('reload after solve', err); });
    },
  });

  const solveStationBtn = getElement<HTMLButtonElement>('solve-station-btn');
  solveStationBtn.addEventListener('click', () => {
    const stationId = getCurrentStationId();
    solveModal.open({
      title: 'Solve station',
      start: (cfg, onEvent, signal) =>
        api.solveStationStream(stationId, cfg, onEvent, signal),
    });
  });
}
