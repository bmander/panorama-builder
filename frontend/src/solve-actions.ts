import * as api from './api.js';
import { createSolveModal } from './solve-modal.js';

export interface SolveActionsDeps {
  getCurrentStationId: () => string;
  rehydrate: () => Promise<void>;
  reportError: (label: string, err: unknown) => void;
}

export interface SolveActions {
  open: () => void;
}

export function attachSolveActions(deps: SolveActionsDeps): SolveActions {
  const { getCurrentStationId, rehydrate, reportError } = deps;

  const solveModal = createSolveModal({
    onComplete: () => {
      rehydrate().catch((err: unknown) => { reportError('reload after solve', err); });
    },
  });

  const open = (): void => {
    const stationId = getCurrentStationId();
    solveModal.open({
      title: 'Solve station',
      start: (cfg, onEvent, signal) =>
        api.solveStationStream(stationId, cfg, onEvent, signal),
    });
  };

  return { open };
}
