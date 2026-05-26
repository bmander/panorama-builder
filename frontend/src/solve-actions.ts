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
      // The solve writes new poses + CP estimates back into the session
      // overlay, so the cached world graph (other stations' poses, CP
      // positions) is now stale — drop it so the next flight refetches.
      api.invalidateWorldCache();
      rehydrate().catch((err: unknown) => { reportError('reload after solve', err); });
    },
  });

  const open = (): void => {
    solveModal.open({ title: 'Solve all (joint)', start: api.solveJointStream });
  };

  return { open };
}
