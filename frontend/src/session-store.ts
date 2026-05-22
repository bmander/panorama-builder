// Owns the active session id: localStorage persistence, lazy single-flight
// creation, and change subscription. Leaf module — depends only on
// request-client.ts and the generated types — so api.ts and session.ts can
// both depend on it without forming a load-time cycle.
//
// The 'panorama:session' localStorage key is defined here exactly once;
// session-pending.ts reads through this module rather than holding its own
// copy of the key.

import { apiRequest } from './request-client.js';
import type { components } from './api-types.gen.js';

type ApiCreateSessionResponse = components['schemas']['CreateSessionResponse'];

const STORAGE_KEY = 'panorama:session';

export interface SessionStore {
  // Returns the current session id (or null if none is active).
  current(): string | null;
  // Persist (or clear) the active session id and notify subscribers.
  setCurrent(id: string | null): void;
  // Lazily POST /api/sessions and persist the new id. If a session is
  // already active, returns its id without round-tripping. Concurrent
  // callers share a single in-flight request.
  ensureStarted(): Promise<string>;
  // Subscribe to changes (id set / cleared). Returns an unsubscribe fn.
  onChange(handler: () => void): () => void;
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private mode etc. — silently fall through; session lives only for
    // this page load.
  }
}

function create(): SessionStore {
  const handlers = new Set<() => void>();
  const notify = (): void => {
    syncBodyEditingClass();
    for (const h of handlers) h();
  };
  let pendingStart: Promise<string> | null = null;

  function setCurrent(id: string | null): void {
    writeStored(id);
    notify();
  }

  async function ensureStarted(): Promise<string> {
    const existing = readStored();
    if (existing !== null) return existing;
    if (pendingStart !== null) return pendingStart;
    pendingStart = (async () => {
      try {
        const resp = await apiRequest<ApiCreateSessionResponse>('POST', '/sessions');
        writeStored(resp.id);
        notify();
        return resp.id;
      } finally {
        pendingStart = null;
      }
    })();
    return pendingStart;
  }

  return {
    current: readStored,
    setCurrent,
    ensureStarted,
    onChange(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  };
}

export const sessionStore: SessionStore = create();

// True when a session is active — i.e. when writes are permitted. UI surfaces
// gate their write affordances on this; the api.ts transport layer also
// throws SessionNotStartedError when this is false.
export function editingActive(): boolean {
  return sessionStore.current() !== null;
}

// Disable a form control whenever no session is active. Subscribes once; the
// returned unsubscribe is rarely needed since most controls live as long as
// their page does.
type Disableable =
  | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;
export function bindDisabledToSession(el: Disableable): () => void {
  const sync = (): void => { el.disabled = !editingActive(); };
  sync();
  return sessionStore.onChange(sync);
}

// Mirror editing state onto <body> as a class so CSS can dim / hide write
// affordances without each module wiring its own listener. Module scripts
// are deferred, so document.body is in place by the time this runs.
function syncBodyEditingClass(): void {
  document.body.classList.toggle('editing', editingActive());
}

syncBodyEditingClass();
