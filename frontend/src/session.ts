// Session manager — owns the X-Session-Id header and the session lifecycle
// (lazy-create on first write, abandon, merge). Persists the active session
// id in localStorage so it survives reloads and lives across this device's
// tabs.
//
// All API helpers in api.ts read sessionManager.current() at request time,
// so handlers don't need to thread the id through manually.

import * as api from './api.js';
import type {
  ApiSessionState, ApiCreateSessionResponse, ApiCommitRef, ApiMergeRequest,
} from './api.js';

const STORAGE_KEY = 'panorama:session';

export interface SessionManager {
  // Returns the current session id (or null if none is active).
  current(): string | null;
  // Lazily POSTs /api/sessions and persists the new id. If a session is
  // already active, returns its id without round-tripping.
  ensureStarted(): Promise<string>;
  // Abandon the current session (server-side mark + clear localStorage).
  // No-op if no session is active. Server failures still clear local state
  // so the user isn't stuck with a stale id.
  abandon(): Promise<void>;
  // Merge the current session into main; clears local state on success.
  // Throws on 409 with conflicts in err.message; caller decides next step.
  merge(req: ApiMergeRequest): Promise<ApiCommitRef>;
  // Refresh the session metadata (op_count, conflicts, etc.). Returns null
  // if no session is active.
  refreshState(): Promise<ApiSessionState | null>;
  // Subscribe to session changes (id updates / merge / abandon). Cheap;
  // every UI panel that displays session info should use this.
  onChange(handler: () => void): () => void;
}

export function createSessionManager(): SessionManager {
  const handlers = new Set<() => void>();
  const notify = (): void => { for (const h of handlers) h(); };

  function readStored(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function setStored(id: string | null): void {
    try {
      if (id === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Private mode etc. — silently fall through; session lives only for
      // this page load.
    }
  }

  function current(): string | null {
    return readStored();
  }

  let pendingStart: Promise<string> | null = null;

  async function ensureStarted(): Promise<string> {
    const existing = current();
    if (existing !== null) return existing;
    if (pendingStart !== null) return pendingStart;
    pendingStart = (async () => {
      try {
        const resp: ApiCreateSessionResponse = await api.createSession();
        setStored(resp.id);
        notify();
        return resp.id;
      } finally {
        pendingStart = null;
      }
    })();
    return pendingStart;
  }

  async function abandon(): Promise<void> {
    const id = current();
    if (id === null) return;
    try {
      await api.abandonSession(id);
    } finally {
      setStored(null);
      notify();
    }
  }

  async function merge(req: ApiMergeRequest): Promise<ApiCommitRef> {
    const id = current();
    if (id === null) throw new Error('no active session to merge');
    const ref = await api.mergeSession(id, req);
    setStored(null);
    notify();
    return ref;
  }

  async function refreshState(): Promise<ApiSessionState | null> {
    const id = current();
    if (id === null) return null;
    try {
      return await api.getSession(id);
    } catch (err) {
      console.error('refresh session state failed:', err);
      return null;
    }
  }

  return {
    current,
    ensureStarted,
    abandon,
    merge,
    refreshState,
    onChange(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  };
}

// Single shared instance — api.ts reads this directly to inject the header.
export const sessionManager: SessionManager = createSessionManager();
