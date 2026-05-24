import * as api from './api.js';
import { createSolveModal } from './solve-modal.js';

export interface SolveActionsDeps {
  rehydrate: () => Promise<void>;
  reportError: (label: string, err: unknown) => void;
}

export interface SolveActions {
  open: () => void;
}

export function attachSolveActions(deps: SolveActionsDeps): SolveActions {
  const { rehydrate, reportError } = deps;

  const solveModal = createSolveModal({
    onComplete: () => {
      rehydrate().catch((err: unknown) => { reportError('reload after solve', err); });
    },
  });

  const open = (): void => {
    solveModal.open({ title: 'Solve all (joint)', start: api.solveJointStream });
  };

  return { open };
}
