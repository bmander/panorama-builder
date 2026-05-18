// Session lifecycle: abandon, merge, refreshState. The storage primitives
// (current id, ensureStarted, onChange) live in session-store.ts; this
// module is a thin orchestrator over the store and api.ts. Splitting these
// is what lets api.ts depend on sessionStore without forming a cycle —
// session.ts is now a one-way consumer of api.ts.

import * as api from './api.js';
import { sessionStore } from './session-store.js';
import type { ApiSessionState, ApiCommitRef, ApiMergeRequest } from './api.js';

// Abandon the current session (server-side mark + clear local id). No-op if
// no session is active. Server failures still clear local state so the user
// isn't stuck with a stale id.
export async function abandon(): Promise<void> {
  const id = sessionStore.current();
  if (id === null) return;
  try {
    await api.abandonSession(id);
  } finally {
    sessionStore.setCurrent(null);
  }
}

// Merge the current session into main; clears local state on success.
// Throws on 409 with conflicts (SessionConflictError) so callers can branch.
export async function merge(req: ApiMergeRequest): Promise<ApiCommitRef> {
  const id = sessionStore.current();
  if (id === null) throw new Error('no active session to merge');
  const ref = await api.mergeSession(id, req);
  sessionStore.setCurrent(null);
  return ref;
}

// Refresh the session metadata (op_count, conflicts, etc.). Returns null
// if no session is active.
export async function refreshState(): Promise<ApiSessionState | null> {
  const id = sessionStore.current();
  if (id === null) return null;
  try {
    return await api.getSession(id);
  } catch (err) {
    console.error('refresh session state failed:', err);
    return null;
  }
}
