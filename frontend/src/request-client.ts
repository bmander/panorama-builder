// Low-level fetch + JSON + error wrapping for the backend at /api/*. Pure
// leaf module: no imports from session or api modules, so it sits below
// both in the dependency graph and breaks the load-time cycle that used to
// run api ↔ session.

const API = '/api';

export function apiUrl(path: string): string {
  return API + path;
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

export async function apiRequest<T>(method: string, path: string, opts?: RequestOpts): Promise<T> {
  const res = await fetch(apiUrl(path), buildInit(method, opts));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status.toString()} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function apiRequestVoid(method: string, path: string, opts?: RequestOpts): Promise<void> {
  const res = await fetch(apiUrl(path), buildInit(method, opts));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status.toString()} ${text}`);
  }
}

// Raw fetch escape hatch for endpoints with custom status handling
// (mergeSession 409/422, revertCommit 409), SSE solve streams, or blob bodies.
// Callers assemble their own RequestInit (headers, body, signal) and parse
// the Response themselves.
export function apiFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}
