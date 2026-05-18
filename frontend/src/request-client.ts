// Low-level fetch + JSON + error wrapping for the backend at /api/*. Pure
// leaf module — no imports from session or api modules — so it can sit
// below both in the dependency graph.

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

async function fetchOk(method: string, path: string, opts?: RequestOpts): Promise<Response> {
  const res = await fetch(apiUrl(path), buildInit(method, opts));
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
// streaming response bodies, or non-JSON request bodies.
export function apiFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}
