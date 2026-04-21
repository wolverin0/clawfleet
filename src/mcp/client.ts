/**
 * HTTP client used by the v3.0 MCP tools to talk to the dashboard backend.
 *
 * Every MCP tool is a thin wrapper: validate input → call one of these helpers
 * → shape the result into the v2.7-compatible `{ content, isError? }` envelope.
 * That way Phase 7's active omniclaude can reuse the same HTTP surface, and
 * Phase 9's bearer-token auth slots in by adding a single header here.
 */

import { DEFAULT_DASHBOARD_PORT } from '../shared/types.js';

export interface BackendClientOptions {
  baseUrl?: string;
  token?: string | null;
}

const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`;

export class BackendHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'BackendHttpError';
    this.status = status;
    this.body = body;
  }
}

function resolveBaseUrl(opts: BackendClientOptions | undefined): string {
  if (opts?.baseUrl) return opts.baseUrl.replace(/\/$/, '');
  if (process.env.THEORCHESTRA_BACKEND_URL) {
    return process.env.THEORCHESTRA_BACKEND_URL.replace(/\/$/, '');
  }
  if (process.env.THEORCHESTRA_PORT) {
    return `http://127.0.0.1:${process.env.THEORCHESTRA_PORT}`;
  }
  return DEFAULT_BASE_URL;
}

function readTokenFile(): string | null {
  try {
    // Lazy require so edge cases (bundled build w/o fs) still boot.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    const file =
      process.env.THEORCHESTRA_TOKEN_FILE ??
      path.resolve(process.cwd(), 'vault', '_auth', 'token.json');
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as { token?: string };
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
}

function resolveToken(opts: BackendClientOptions | undefined): string | null {
  if (opts?.token !== undefined) return opts.token;
  if (process.env.THEORCHESTRA_TOKEN) return process.env.THEORCHESTRA_TOKEN;
  return readTokenFile();
}

async function request<T>(
  method: string,
  path: string,
  opts: BackendClientOptions | undefined,
  body?: unknown,
): Promise<T> {
  const url = `${resolveBaseUrl(opts)}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = resolveToken(opts);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg = `backend ${res.status} on ${method} ${path}`;
    throw new BackendHttpError(res.status, parsed, msg);
  }
  return parsed as T;
}

export const backendClient = {
  health: (opts?: BackendClientOptions) =>
    request<{ ok: boolean; version: string }>('GET', '/api/health', opts),

  listSessions: (opts?: BackendClientOptions) =>
    request<unknown[]>('GET', '/api/sessions', opts),

  getSession: (sessionId: string, opts?: BackendClientOptions) =>
    request<unknown>('GET', `/api/sessions/${encodeURIComponent(sessionId)}`, opts),

  spawnSession: (body: unknown, opts?: BackendClientOptions) =>
    request<unknown>('POST', '/api/sessions', opts, body),

  killSession: (sessionId: string, opts?: BackendClientOptions) =>
    request<unknown>('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`, opts),

  readOutput: (sessionId: string, lines: number, opts?: BackendClientOptions) =>
    request<{ session_id: string; lines: string[] }>(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/output?lines=${lines}`,
      opts,
    ),

  getStatus: (sessionId: string, opts?: BackendClientOptions) =>
    request<unknown>('GET', `/api/sessions/${encodeURIComponent(sessionId)}/status`, opts),

  sendPrompt: (sessionId: string, text: string, opts?: BackendClientOptions) =>
    request<unknown>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
      opts,
      { text },
    ),

  sendKey: (sessionId: string, key: string, opts?: BackendClientOptions) =>
    request<unknown>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/key`,
      opts,
      { key },
    ),

  setTitle: (sessionId: string, title: string, opts?: BackendClientOptions) =>
    request<unknown>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/title`,
      opts,
      { title },
    ),

  waitForIdle: (
    sessionId: string,
    maxWaitS: number,
    pollIntervalS: number,
    opts?: BackendClientOptions,
  ) =>
    request<{
      session_id: string;
      timed_out: boolean;
      status: string;
      last_lines: string[];
    }>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/wait-idle`,
      opts,
      { max_wait_s: maxWaitS, poll_interval_s: pollIntervalS },
    ),

  listProjects: (opts?: BackendClientOptions) =>
    request<{ projects: unknown[] }>('GET', '/api/projects', opts),

  listWorkspaces: (opts?: BackendClientOptions) =>
    request<{ workspaces: unknown[] }>('GET', '/api/workspaces', opts),

  listPersonas: (opts?: BackendClientOptions) =>
    request<{ personas: Array<{ name: string; filePath: string; description: string; category: string | null }> }>(
      'GET',
      '/api/personas',
      opts,
    ),

  autoHandoff: (sessionId: string, body: { focus?: string; force?: boolean }, opts?: BackendClientOptions) =>
    request<unknown>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/auto-handoff`, opts, body),

  prdBootstrap: (source: string, opts?: BackendClientOptions) =>
    request<{ project: string; cwd: string; spawned: Array<{ role: string; session_id: string; persona: string | null }> }>(
      'POST',
      '/api/prd-bootstrap',
      opts,
      { source },
    ),

  // P7.C — omniclaude's eyes + hands.
  snapshotDashboard: (opts?: BackendClientOptions) =>
    request<{
      capturedAt: string;
      latencyMs: number;
      refsCount: number;
      refs: Record<string, { name: string; role: string }>;
      snapshotText: string | null;
      error?: string;
    }>('POST', '/api/orchestrator/snapshot', opts),

  actOnRef: (ref: string, verb: 'click' | 'hover' | 'focus' | 'dblclick', opts?: BackendClientOptions) =>
    request<{ ok: boolean; ref: string; verb: string }>(
      'POST',
      '/api/orchestrator/act',
      opts,
      { ref, verb },
    ),

  getRecentDecisions: (limit: number, opts?: BackendClientOptions) =>
    request<{ decisions: unknown[] }>(
      'GET',
      `/api/orchestrator/decisions?limit=${limit}`,
      opts,
    ),

  getChatMessages: (limit: number, opts?: BackendClientOptions) =>
    request<{ messages: unknown[] }>(
      'GET',
      `/api/chat/messages?limit=${limit}`,
      opts,
    ),

  askUser: (topic: string, text: string, sessionId: string | null, opts?: BackendClientOptions) =>
    request<unknown>(
      'POST',
      '/api/chat/orchestrator-ask',
      opts,
      { topic, text, session_id: sessionId },
    ),
};
