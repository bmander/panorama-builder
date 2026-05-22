// Low-level fetch + JSON + error wrapping for the read/write Go backends.
// Two origins are supported so the frontend can talk to a scale-to-zero
// reader and a heavier editor independently. Defaults: both `/api` →
// same-origin (Vite proxy in dev, or a single backend serving everything).
//
// Routing rules:
//   - sessionId present              → write base (sessions live on editor)
//   - GET/HEAD without session       → read base
//   - any other method without sess. → write base (writes need editor anyway)
//
// Pure leaf module — no imports from session or api modules — so it can
// sit below both in the dependency graph.

const READ_BASE = (import.meta.env.VITE_READ_API_BASE ?? '/api') as string;
const WRITE_BASE = (import.meta.env.VITE_WRITE_API_BASE ?? READ_BASE) as string;

function pickBase(method: string, sessionId: string | null | undefined): string {
  if (sessionId) return WRITE_BASE;
  if (method === 'GET' || method === 'HEAD') return READ_BASE;
  return WRITE_BASE;
}

// Read-side URL builder used by callers that need a plain URL (e.g. <img src>
// for blob/preview endpoints). Always returns the read base; explicit-write
// call sites use apiFetch which targets the write base.
export function apiUrl(path: string): string {
  return READ_BASE + path;
}

export interface RequestOpts {
  body?: unknown;
  sessionId?: string | null;
  signal?: AbortSignal;
}

function buildInit(method: string, opts?: RequestOpts): RequestInit {
  const headers = new Headers();
  const init: RequestInit = { method, headers };
  if (opts?.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(opts.body);
  }
  if (opts?.sessionId) headers.set('X-Session-Id', opts.sessionId);
  if (opts?.signal) init.signal = opts.signal;
  return init;
}

async function fetchOk(method: string, path: string, opts?: RequestOpts): Promise<Response> {
  const base = pickBase(method, opts?.sessionId);
  const res = await fetch(base + path, buildInit(method, opts));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status.toString()} ${text}`);
  }
  return res;
}

export async function apiRequest<T>(method: string, path: string, opts?: RequestOpts): Promise<T> {
  const res = await fetchOk(method, path, opts);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function apiRequestVoid(method: string, path: string, opts?: RequestOpts): Promise<void> {
  await fetchOk(method, path, opts);
}

// Raw fetch escape hatch for callers that need custom status handling,
// streaming response bodies, or non-JSON request bodies. All current
// callers are session-scoped writes (blob upload, solve, merge, revert),
// so this always targets the write base.
export function apiFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(WRITE_BASE + path, init);
}
