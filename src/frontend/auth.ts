/**
 * Frontend auth helper — one place that knows about the bearer token.
 *
 *   - getToken() / setToken() / clearToken() manage localStorage
 *   - authedFetch() attaches Authorization + credentials
 *   - wsUrl() builds `ws://host/ws/pty/:id?token=<t>` since browsers can't
 *     set headers on a WebSocket upgrade
 *   - checkAuth() asks the backend whether auth is required + whether the
 *     current stored token is accepted
 */

const STORAGE_KEY = 'theorchestra.token';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* quota / incognito — caller handles via re-prompt */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export async function authedFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers ?? {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

export function wsUrl(sessionId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  const token = getToken();
  const base = `${proto}${window.location.host}/ws/pty/${encodeURIComponent(sessionId)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export interface AuthCheck {
  required: boolean;
  tokenValid: boolean;
}

/**
 * Two probes:
 *   1. `GET /api/auth/status` — tells us whether the backend needs a token.
 *      Un-gated, so safe to call without a token.
 *   2. `GET /api/sessions` — if the stored token works, we're in.
 */
export async function checkAuth(): Promise<AuthCheck> {
  try {
    const statusRes = await fetch('/api/auth/status');
    if (!statusRes.ok) {
      return { required: false, tokenValid: false };
    }
    const status = (await statusRes.json()) as { required: boolean };
    if (!status.required) {
      return { required: false, tokenValid: true };
    }
  } catch {
    return { required: false, tokenValid: false };
  }

  const token = getToken();
  if (!token) return { required: true, tokenValid: false };
  try {
    const sessionsRes = await authedFetch('/api/sessions');
    return { required: true, tokenValid: sessionsRes.ok };
  } catch {
    return { required: true, tokenValid: false };
  }
}
