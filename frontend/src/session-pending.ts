// Tracks the per-session state that drives the solver-aware session widget:
//   - userPending: solver-relevant frontend mutations since the last solve
//     (or session start). Bumped from api.ts on each successful write.
//   - solverChanges: number of changes the most recent completed solve
//     applied. null until a solve has run for this session.
//
// State is persisted in localStorage keyed by the active session id so the
// counters survive a page refresh. When the session id changes (or clears)
// the persisted snapshot is dropped.

import { sessionStore } from './session-store.js';

const STORAGE_KEY = 'panorama:session-pending';

interface PersistedState {
  sessionId: string;
  userPending: number;
  solverChanges: number | null;
}

export interface SessionPendingState {
  readonly userPending: number;
  readonly solverChanges: number | null;
}

export interface SessionPendingTracker {
  get(): SessionPendingState;
  bumpUser(): void;
  recordSolve(changes: number): void;
  reset(): void;
  onChange(handler: () => void): () => void;
}

function readPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    return JSON.parse(raw) as PersistedState;
  } catch { return null; }
}

function writePersisted(state: PersistedState | null): void {
  try {
    if (state === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* private mode etc. — counters live for this page only */ }
}

function createSessionPendingTracker(): SessionPendingTracker {
  let userPending = 0;
  let solverChanges: number | null = null;
  const handlers = new Set<() => void>();
  const notify = (): void => { for (const h of handlers) h(); };

  // Restore from a previous page-load if the session id still matches.
  const persisted = readPersisted();
  const sid = sessionStore.current();
  if (persisted !== null && sid !== null && persisted.sessionId === sid) {
    userPending = persisted.userPending;
    solverChanges = persisted.solverChanges;
  } else if (persisted !== null) {
    // Stale snapshot from a session that has since merged or been abandoned.
    writePersisted(null);
  }

  function persist(): void {
    const id = sessionStore.current();
    if (id === null) {
      writePersisted(null);
      return;
    }
    writePersisted({ sessionId: id, userPending, solverChanges });
  }

  return {
    get: () => ({ userPending, solverChanges }),
    bumpUser() {
      userPending += 1;
      persist();
      notify();
    },
    recordSolve(changes) {
      solverChanges = changes;
      userPending = 0;
      persist();
      notify();
    },
    reset() {
      if (userPending === 0 && solverChanges === null) {
        writePersisted(null);
        return;
      }
      userPending = 0;
      solverChanges = null;
      writePersisted(null);
      notify();
    },
    onChange(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  };
}

export const sessionPending: SessionPendingTracker = createSessionPendingTracker();
