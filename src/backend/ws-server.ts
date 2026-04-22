/**
 * HTTP + WebSocket server for Phase 1.
 *
 * Surface:
 *   GET  /api/health              → { ok, version }
 *   GET  /api/sessions            → SessionRecord[]
 *   POST /api/sessions (JSON)     → SessionRecord  (spawns a new pty)
 *   WS   /ws/pty/<sessionId>      → bidirectional pty stream (see shared/types.ts)
 *
 * CORS is wide-open during Phase 1 (Phase 9 tightens under bearer auth).
 */

import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { PtyManager, type PtyDataEvent, type PtyExitEvent } from './pty-manager.js';
import { EventBus, writeSseEvent, writeSseHeaders } from './events.js';
import { runAutoHandoff, type AutoHandoffTimeouts } from './auto-handoff.js';
import { runA2aHandoff, listHandoffs } from './handoff-routes.js';
import { PaneQueueStore } from './pane-queue.js';
import { injectContext } from './inject-context.js';
import { getLastCtxPercent } from './event-emitters/status-bar.js';
import { listPersonas, resolvePersona } from './personas.js';
import {
  addWorktree,
  defaultWorktreePath,
  listWorktrees,
  removeWorktree,
} from './worktree.js';
import { parsePrdYaml, type PrdSpec } from './prd-bootstrap.js';
import type { ChatStore } from './orchestrator/chat.js';
import type { DashboardController, DashboardActVerb } from './orchestrator/dashboard-controller.js';
import type { LlmAdvisor } from './orchestrator/llm-advisor.js';
import type { DecisionLog } from './orchestrator/decision-log.js';
import { readTasks } from './event-emitters/stuck-and-tasks.js';
import {
  AuthStore,
  extractBearerFromHeader,
  extractTokenFromUrl,
  isExemptFromAuth,
} from './auth.js';
import {
  DEFAULT_DASHBOARD_PORT,
  WS_PATH_PREFIX,
  type ClientMessage,
  type PtySpawnOptions,
  type ServerMessage,
  type SessionId,
} from '../shared/types.js';

const VERSION = '3.0.0-alpha.1';

const FRONTEND_DIST = path.resolve(__dirname, '..', '..', 'dist', 'frontend');

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function tryServeStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const rawUrl = (req.url ?? '/').split('?')[0] ?? '/';
  const relative = rawUrl === '/' ? 'index.html' : rawUrl.replace(/^\/+/, '');
  const resolved = path.resolve(FRONTEND_DIST, relative);
  if (!resolved.startsWith(FRONTEND_DIST)) return false;
  try {
    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mime = STATIC_MIME[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  } catch {
    // SPA fallback: any unknown GET serves index.html so the client router handles it.
    if (rawUrl === '/' || rawUrl.includes('.')) return false;
    try {
      const indexHtml = await fs.readFile(path.join(FRONTEND_DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : indexHtml);
      return true;
    } catch {
      return false;
    }
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function isSpawnOptions(v: unknown): v is PtySpawnOptions {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.cli === 'string' && o.cli.length > 0;
}

/**
 * Translate v2.7-compatible key aliases into byte sequences to write to the PTY.
 *
 * Covers everything the dashboard key-strip can fire, including the interactive-
 * menu navigation keys Claude needs (`/mcp`, `/status`, permission picker). ANSI
 * sequences match xterm/VT100 conventions — same ones node-pty/ConPTY emits from
 * a real keyboard.
 */
function keyAliasToBytes(key: string): string {
  const k = key.toLowerCase().trim();
  switch (k) {
    case 'enter':
    case 'return':
      return '\r';
    case 'ctrl+c':
    case 'ctrl-c':
      return '\x03';
    case 'alt+m':
    case 'meta+m':
      return '\x1bm';
    // Menu navigation — critical for Claude TUIs.
    case 'esc':
    case 'escape':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'shift+tab':
    case 'shift-tab':
      return '\x1b[Z';
    case 'up':
    case 'arrowup':
      return '\x1b[A';
    case 'down':
    case 'arrowdown':
      return '\x1b[B';
    case 'right':
    case 'arrowright':
      return '\x1b[C';
    case 'left':
    case 'arrowleft':
      return '\x1b[D';
    case 'home':
      return '\x1b[H';
    case 'end':
      return '\x1b[F';
    case 'pageup':
    case 'page-up':
      return '\x1b[5~';
    case 'pagedown':
    case 'page-down':
      return '\x1b[6~';
    case 'backspace':
      return '\x7f';
    case 'delete':
    case 'del':
      return '\x1b[3~';
    case 'space':
      return ' ';
    case 'y':
    case '1':
      return '1';
    case 'n':
    case '2':
      return '2';
    case '3':
      return '3';
    default:
      return key;
  }
}

function parsePath(rawUrl: string): { pathname: string; query: URLSearchParams } {
  const q = rawUrl.indexOf('?');
  const pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = new URLSearchParams(q === -1 ? '' : rawUrl.slice(q + 1));
  return { pathname, query };
}

interface SessionRouteMatch {
  sessionId: string;
  suffix: string; // '' | 'output' | 'status' | 'prompt' | 'key' | 'title' | 'wait-idle' | 'auto-handoff'
}

function matchSessionRoute(pathname: string): SessionRouteMatch | null {
  if (!pathname.startsWith('/api/sessions/')) return null;
  const rest = pathname.slice('/api/sessions/'.length);
  if (rest.length === 0) return null;
  const slash = rest.indexOf('/');
  if (slash === -1) return { sessionId: rest, suffix: '' };
  const sessionId = rest.slice(0, slash);
  const suffix = rest.slice(slash + 1);
  return { sessionId, suffix };
}

function makeHttpHandler(
  manager: PtyManager,
  bus: EventBus,
  getChat: () => ChatStore | null,
  auth: AuthStore | null,
  queueStore: PaneQueueStore,
  getDashboard: () => DashboardController | null,
  getAdvisor: () => LlmAdvisor | null,
  getDecisionLog: () => DecisionLog | null,
) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'OPTIONS' && url.startsWith('/api/')) {
      res.writeHead(204, {
        ...CORS_HEADERS,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    const { pathname, query } = parsePath(url);

    // Bearer-token gate. Skipped entirely if auth is null (pre-Phase 9 callers).
    if (auth && !isExemptFromAuth(pathname, method)) {
      const headerToken = extractBearerFromHeader(
        (req.headers.authorization ?? req.headers.Authorization) as string | undefined,
      );
      const urlToken = headerToken ? null : extractTokenFromUrl(url);
      const candidate = headerToken ?? urlToken;
      if (!auth.verify(candidate)) {
        writeJson(res, 401, { error: 'unauthorized', detail: 'missing or invalid bearer token' });
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/health') {
      writeJson(res, 200, { ok: true, version: VERSION });
      return;
    }

    // Phase 9 auth endpoints (un-gated by design).

    if (method === 'GET' && pathname === '/api/auth/status') {
      if (!auth) {
        writeJson(res, 200, { required: false });
        return;
      }
      writeJson(res, 200, { required: true, initialized: auth.exists() });
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/rotate') {
      if (!auth) {
        writeJson(res, 400, { error: 'auth_not_configured' });
        return;
      }
      // Rotating requires the CURRENT token in Authorization header.
      const candidate = extractBearerFromHeader(
        (req.headers.authorization ?? req.headers.Authorization) as string | undefined,
      );
      if (!auth.verify(candidate)) {
        writeJson(res, 401, { error: 'unauthorized', detail: 'current token required for rotate' });
        return;
      }
      const newToken = auth.rotate();
      writeJson(res, 200, { token: newToken, rotatedAt: new Date().toISOString() });
      return;
    }

    if (method === 'GET' && pathname === '/events') {
      writeSseHeaders(res);
      const unsubscribe = bus.subscribe((evt) => writeSseEvent(res, evt));
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 30_000);
      const onClose = (): void => {
        unsubscribe();
        clearInterval(heartbeat);
      };
      req.on('close', onClose);
      req.on('error', onClose);
      // Don't end() — SSE is kept open until the client disconnects.
      return;
    }

    if (method === 'GET' && pathname === '/api/sessions') {
      // Optional enhancement point — omitted from conditional chain duplication.
      // Fall through to the existing '/api/sessions' handler below.
    }

    if (method === 'GET' && pathname === '/api/sessions') {
      // P7.A3: filter omniclaude unless ?include_omni=1 is set.
      const omniSid = process.env.THEORCHESTRA_OMNICLAUDE_SID ?? null;
      const includeOmni = query.get('include_omni') === '1';
      const all = manager.list();
      const filtered =
        omniSid && !includeOmni ? all.filter((r) => r.sessionId !== omniSid) : all;
      writeJson(res, 200, filtered);
      return;
    }

    // P7.A3: dedicated endpoint for the Omni tab to fetch just omniclaude.
    if (method === 'GET' && pathname === '/api/orchestrator/omniclaude') {
      const omniSid = process.env.THEORCHESTRA_OMNICLAUDE_SID ?? null;
      if (!omniSid) {
        writeJson(res, 200, { enabled: false, session: null });
        return;
      }
      const rec = manager.get(omniSid);
      if (!rec) {
        writeJson(res, 200, { enabled: true, session: null, note: 'omniclaude sid set but pane not found' });
        return;
      }
      writeJson(res, 200, { enabled: true, session: rec });
      return;
    }

    if (method === 'POST' && pathname === '/api/sessions') {
      try {
        const body = await readJsonBody(req);
        if (!isSpawnOptions(body)) {
          writeJson(res, 400, { error: 'invalid_body', detail: 'cli (string) required' });
          return;
        }
        const record = manager.spawn(body);
        writeJson(res, 201, record);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJson(res, 400, { error: 'spawn_failed', detail: msg });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/projects') {
      // Group live sessions by the basename of their cwd. Phase 2 stub;
      // Phase 2+ may wire a real project-scanner if the user wants to see
      // projects that don't currently have an open session.
      const byProject = new Map<string, string[]>();
      for (const rec of manager.list()) {
        const projectName = path.basename(rec.cwd) || rec.cwd;
        const list = byProject.get(projectName) ?? [];
        list.push(rec.sessionId);
        byProject.set(projectName, list);
      }
      const projects = Array.from(byProject.entries()).map(([name, sessionIds]) => ({
        name,
        session_count: sessionIds.length,
        session_ids: sessionIds,
      }));
      writeJson(res, 200, { projects });
      return;
    }

    if (method === 'GET' && pathname === '/api/workspaces') {
      // Phase 2 stub — single "default" workspace. Real multi-workspace
      // support lands with the dashboard layout work in Phase 6.
      writeJson(res, 200, {
        workspaces: [
          { name: 'default', session_ids: manager.list().map((r) => r.sessionId) },
        ],
      });
      return;
    }

    // Phase 5 — agency mode endpoints.

    // Debug: publish a synthetic event onto the bus. Only enabled when
    // THEORCHESTRA_DEBUG_EVENTS=1. Used by Playwright gates to exercise
    // event-driven UI paths without relying on the emitter chain.
    if (method === 'POST' && pathname === '/api/_debug/publish') {
      if (process.env.THEORCHESTRA_DEBUG_EVENTS !== '1') {
        writeJson(res, 404, { error: 'not_found' });
        return;
      }
      try {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        if (typeof body.type !== 'string') {
          writeJson(res, 400, { error: 'invalid_body', detail: 'type (string) required' });
          return;
        }
        const evt = bus.publish(body as never);
        writeJson(res, 201, evt);
      } catch (err) {
        writeJson(res, 400, {
          error: 'publish_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/tasks') {
      // Read the same active_tasks.md the watcher watches. Path is taken from
      // THEORCHESTRA_TASKS_FILE so gate harnesses can redirect.
      const tasksFile =
        process.env.THEORCHESTRA_TASKS_FILE ?? path.resolve('vault', 'active_tasks.md');
      try {
        const tasks = readTasks(tasksFile);
        writeJson(res, 200, { path: tasksFile, tasks });
      } catch (err) {
        writeJson(res, 500, {
          error: 'tasks_read_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/personas') {
      const personas = listPersonas();
      writeJson(res, 200, { personas });
      return;
    }

    // v2.7-parity handoff endpoints.
    if (method === 'POST' && pathname === '/api/a2a/handoff') {
      try {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const result = runA2aHandoff(manager, body);
        writeJson(res, 200, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /required|not found/i.test(msg) ? 400 : 500;
        writeJson(res, code, { error: 'a2a_handoff_failed', detail: msg });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/handoffs') {
      const sessionId = query.get('session') ?? query.get('sessionId');
      if (!sessionId) {
        writeJson(res, 400, { error: 'missing_session', detail: '?session=<id> required' });
        return;
      }
      try {
        const result = listHandoffs(manager, sessionId);
        writeJson(res, 200, result);
      } catch (err) {
        writeJson(res, 500, {
          error: 'list_handoffs_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/worktrees') {
      const repoPath = query.get('repo');
      if (!repoPath) {
        writeJson(res, 400, { error: 'missing_repo', detail: '?repo=<absolute path> required' });
        return;
      }
      try {
        const paths = await listWorktrees(repoPath);
        writeJson(res, 200, { repo: repoPath, worktrees: paths });
      } catch (err) {
        writeJson(res, 500, {
          error: 'list_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/worktree') {
      try {
        const body = (await readJsonBody(req)) as {
          repo?: unknown;
          branch?: unknown;
          worktree_path?: unknown;
          create_branch?: unknown;
        };
        if (typeof body.repo !== 'string' || typeof body.branch !== 'string') {
          writeJson(res, 400, {
            error: 'invalid_body',
            detail: 'repo (string, absolute) + branch (string) required',
          });
          return;
        }
        const worktreePath =
          typeof body.worktree_path === 'string' && body.worktree_path.length > 0
            ? body.worktree_path
            : defaultWorktreePath(body.repo, body.branch);
        const result = await addWorktree({
          repoPath: body.repo,
          branch: body.branch,
          worktreePath,
          createBranch: body.create_branch !== false,
        });
        writeJson(res, 201, result);
      } catch (err) {
        writeJson(res, 400, {
          error: 'add_worktree_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (method === 'DELETE' && pathname === '/api/worktree') {
      try {
        const body = (await readJsonBody(req)) as {
          repo?: unknown;
          worktree_path?: unknown;
          force?: unknown;
        };
        if (typeof body.repo !== 'string' || typeof body.worktree_path !== 'string') {
          writeJson(res, 400, {
            error: 'invalid_body',
            detail: 'repo + worktree_path (both strings, absolute) required',
          });
          return;
        }
        await removeWorktree(body.repo, body.worktree_path, Boolean(body.force));
        writeJson(res, 200, { removed: body.worktree_path });
      } catch (err) {
        writeJson(res, 400, {
          error: 'remove_worktree_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Phase 7 — chat endpoints.
    if (method === 'GET' && pathname === '/api/chat/messages') {
      const chat = getChat();
      if (!chat) {
        writeJson(res, 503, { error: 'chat_not_ready', detail: 'orchestrator not yet attached' });
        return;
      }
      const limit = Number.parseInt(query.get('limit') ?? '100', 10) || 100;
      writeJson(res, 200, { messages: chat.latest(limit) });
      return;
    }

    if (method === 'POST' && pathname === '/api/chat/ask') {
      // User-initiated message. Rare in practice — most asks originate from
      // the orchestrator — but exposed for symmetry.
      try {
        const body = (await readJsonBody(req)) as { text?: unknown };
        if (typeof body.text !== 'string' || body.text.length === 0) {
          writeJson(res, 400, { error: 'invalid_body', detail: 'text (string) required' });
          return;
        }
        const chat = getChat();
        if (!chat) {
          writeJson(res, 503, { error: 'chat_not_ready' });
          return;
        }
        writeJson(res, 201, chat.userMessage(body.text));
      } catch (err) {
        writeJson(res, 400, {
          error: 'ask_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // 2026-04-21 — user-to-omniclaude direct prompt. Writes to chat.userMessage
    // (so it shows in the chat history + is fetchable via get_chat_messages MCP)
    // AND enqueues a [USER_MESSAGE] prompt into omniclaude's pane so it acts
    // on the next turn instead of waiting to poll.
    if (method === 'POST' && pathname === '/api/orchestrator/tell-omni') {
      try {
        const body = (await readJsonBody(req)) as { text?: unknown };
        if (typeof body.text !== 'string' || body.text.trim().length === 0) {
          writeJson(res, 400, { error: 'invalid_body', detail: 'text (string) required' });
          return;
        }
        const chat = getChat();
        if (!chat) {
          writeJson(res, 503, { error: 'chat_not_ready' });
          return;
        }
        const msg = chat.userMessage(body.text);
        // Enqueue into omniclaude's pane if it's alive.
        const omniSid = process.env.THEORCHESTRA_OMNICLAUDE_SID ?? null;
        let enqueued = false;
        let drained = false;
        if (omniSid) {
          const detail = manager.statusDetail(omniSid);
          if (detail && detail.status !== 'exited') {
            const prompt = `[USER_MESSAGE from dashboard]\n${body.text}\nRespond with MCP tool calls + a DECISION line.`;
            try {
              // Jump the queue — user missions must not be starved behind
              // pane_idle event backlog. See queue-starvation root cause doc.
              queueStore.enqueueFront(omniSid, prompt);
              enqueued = true;
              // If omniclaude is already idle, the queue's pane_idle subscriber
              // won't fire (no transition). Kick the drain manually so the
              // prompt actually reaches the pane.
              if (detail.status === 'idle') {
                try {
                  queueStore.drainOne(manager, omniSid);
                  drained = true;
                } catch {
                  /* ignore */
                }
              }
            } catch {
              /* ignore */
            }
          }
        }
        writeJson(res, 201, { message: msg, enqueuedToOmniclaude: enqueued, drainedImmediately: drained });
      } catch (err) {
        writeJson(res, 400, {
          error: 'tell_omni_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // P7.C — omniclaude uses this to explicitly escalate to the user.
    // Identical semantics to `chat.ask()` firing from the executor, but
    // callable over HTTP so the omniclaude pane (or its MCP tool) can
    // surface content-class decisions.
    if (method === 'POST' && pathname === '/api/chat/orchestrator-ask') {
      try {
        const body = (await readJsonBody(req)) as {
          topic?: unknown;
          text?: unknown;
          session_id?: unknown;
        };
        if (typeof body.topic !== 'string' || typeof body.text !== 'string') {
          writeJson(res, 400, {
            error: 'invalid_body',
            detail: 'topic (string) + text (string) required',
          });
          return;
        }
        const chat = getChat();
        if (!chat) {
          writeJson(res, 503, { error: 'chat_not_ready' });
          return;
        }
        const sid = typeof body.session_id === 'string' ? body.session_id : null;
        writeJson(res, 201, chat.ask(sid, body.topic, body.text));
      } catch (err) {
        writeJson(res, 400, {
          error: 'orchestrator_ask_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/chat/answer') {
      try {
        const body = (await readJsonBody(req)) as { in_reply_to?: unknown; text?: unknown };
        if (typeof body.in_reply_to !== 'string' || typeof body.text !== 'string') {
          writeJson(res, 400, {
            error: 'invalid_body',
            detail: 'in_reply_to (string) + text (string) required',
          });
          return;
        }
        const chat = getChat();
        if (!chat) {
          writeJson(res, 503, { error: 'chat_not_ready' });
          return;
        }
        writeJson(res, 201, chat.answer(body.in_reply_to, body.text));
      } catch (err) {
        writeJson(res, 400, {
          error: 'answer_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // 2026-04-21 — dashboard observation + action endpoints (agent-browser).
    if (method === 'POST' && pathname === '/api/orchestrator/snapshot') {
      const dashboard = getDashboard();
      if (!dashboard) {
        writeJson(res, 503, { error: 'dashboard_not_ready' });
        return;
      }
      if (!dashboard.enabled) {
        writeJson(res, 503, {
          error: 'dashboard_disabled',
          detail: 'THEORCHESTRA_NO_DASHBOARD_SNAPSHOT=1 is set',
        });
        return;
      }
      try {
        const snap = await dashboard.snapshot();
        writeJson(res, 200, snap);
      } catch (err) {
        writeJson(res, 500, {
          error: 'snapshot_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // 2026-04-21 — LLM advisor surface.
    if (method === 'GET' && pathname === '/api/orchestrator/advisor') {
      const advisor = getAdvisor();
      if (!advisor) {
        writeJson(res, 200, {
          enabled: false,
          provider: 'none',
          modelId: 'none',
          callsThisHour: 0,
          hourlyCap: 0,
          cooldownsActive: 0,
          perPaneCooldownSec: 0,
        });
        return;
      }
      const stats = advisor.stats;
      writeJson(res, 200, {
        enabled: advisor.enabled,
        provider: advisor.providerName,
        modelId: advisor.modelId,
        callsThisHour: stats.callsThisHour,
        hourlyCap: stats.hourlyCap,
        cooldownsActive: stats.cooldownsActive,
        perPaneCooldownSec: stats.perPaneCooldownSec,
      });
      return;
    }

    // P6.B3 — runtime toggle. No provider rotation, just on/off.
    if (method === 'POST' && pathname === '/api/orchestrator/advisor/toggle') {
      const advisor = getAdvisor();
      if (!advisor) {
        writeJson(res, 503, { error: 'advisor_not_ready' });
        return;
      }
      try {
        const body = (await readJsonBody(req)) as { enabled?: unknown };
        if (typeof body.enabled !== 'boolean') {
          writeJson(res, 400, { error: 'invalid_body', detail: 'enabled (boolean) required' });
          return;
        }
        advisor.setEnabled(body.enabled);
        writeJson(res, 200, { enabled: advisor.enabled });
      } catch (err) {
        writeJson(res, 400, {
          error: 'toggle_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/orchestrator/decisions') {
      const log = getDecisionLog();
      if (!log) {
        writeJson(res, 503, { error: 'decision_log_not_ready' });
        return;
      }
      const limit = Number.parseInt(query.get('limit') ?? '50', 10) || 50;
      writeJson(res, 200, { decisions: log.tail(Math.min(limit, 200)) });
      return;
    }

    if (method === 'POST' && pathname === '/api/orchestrator/act') {
      const dashboard = getDashboard();
      if (!dashboard) {
        writeJson(res, 503, { error: 'dashboard_not_ready' });
        return;
      }
      if (!dashboard.enabled) {
        writeJson(res, 503, { error: 'dashboard_disabled' });
        return;
      }
      try {
        const body = (await readJsonBody(req)) as { ref?: unknown; verb?: unknown };
        const allowedVerbs: DashboardActVerb[] = ['click', 'hover', 'focus', 'dblclick'];
        if (
          typeof body.ref !== 'string' ||
          typeof body.verb !== 'string' ||
          !allowedVerbs.includes(body.verb as DashboardActVerb)
        ) {
          writeJson(res, 400, {
            error: 'invalid_body',
            detail: `ref (string) + verb (${allowedVerbs.join('|')}) required`,
          });
          return;
        }
        const result = await dashboard.act(body.ref, body.verb as DashboardActVerb);
        if (result.ok) {
          writeJson(res, 200, { ok: true, ref: body.ref, verb: body.verb });
        } else {
          writeJson(res, 500, { error: 'act_failed', detail: result.error });
        }
      } catch (err) {
        writeJson(res, 400, {
          error: 'act_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/prd-bootstrap') {
      try {
        const body = (await readJsonBody(req)) as { source?: unknown };
        if (typeof body.source !== 'string' || body.source.length === 0) {
          writeJson(res, 400, {
            error: 'invalid_body',
            detail: 'source (YAML string) required',
          });
          return;
        }
        let spec: PrdSpec;
        try {
          spec = parsePrdYaml(body.source);
        } catch (err) {
          writeJson(res, 400, {
            error: 'prd_parse_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        const spawned: Array<{ role: string; session_id: string; persona: string | null }> = [];
        // Track panes with pending initial prompts so we can dispatch them
        // AFTER Claude has had time to boot (can't submit to a pane that hasn't
        // rendered its prompt yet — ConPTY swallows early input).
        const pendingPrompts: Array<{ sid: string; prompt: string }> = [];
        for (const role of spec.roles) {
          const personaPath = role.persona ? resolvePersona(role.persona) : null;
          if (role.persona && !personaPath) {
            writeJson(res, 400, {
              error: 'unknown_persona',
              detail: `role "${role.name}" requested persona "${role.persona}" which is not in ~/.claude/agents/`,
            });
            return;
          }
          const isWin = process.platform === 'win32';
          const claudeArgs: string[] = ['--continue'];
          if (personaPath) {
            claudeArgs.splice(0, claudeArgs.length, '--append-system-prompt-file', personaPath);
          }
          if (role.permission_mode) {
            claudeArgs.push('--permission-mode', role.permission_mode);
          }
          // Always bypass permissions for PRD-spawned teams so they can write
          // their role deliverable without blocking on a permission prompt.
          // PRD-bootstrap is an opt-in orchestrator path; the user has already
          // consented to auto-action by POSTing the YAML.
          claudeArgs.push('--dangerously-skip-permissions');
          const cli = isWin ? 'cmd.exe' : 'claude';
          const args = isWin ? ['/c', 'claude', ...claudeArgs] : claudeArgs;
          const record = manager.spawn({
            cli,
            args,
            cwd: spec.cwd,
            tabTitle: role.tab_title ?? `[${role.name}]`,
            persona: role.persona ?? null,
            permissionMode: role.permission_mode ?? null,
          });
          spawned.push({
            role: role.name,
            session_id: record.sessionId,
            persona: role.persona ?? null,
          });
          if (role.prompt && role.prompt.trim().length > 0) {
            pendingPrompts.push({ sid: record.sessionId, prompt: role.prompt });
          }
        }

        // Fire the initial role prompts asynchronously. We wait 8s for Claude
        // to finish its TUI boot (banner + `❯` prompt), then use writeAndSubmit
        // which emits the text and the Enter as two separate PTY chunks (the
        // two-chunk pattern that dodges ConPTY Enter-absorption, confirmed by
        // v2.7 dogfood). If this respond-202-now-dispatch-later pattern breaks
        // down we can poll for the ❯ ready signal later.
        if (pendingPrompts.length > 0) {
          setTimeout(() => {
            for (const { sid, prompt } of pendingPrompts) {
              manager.writeAndSubmit(sid, prompt, 300).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[prd-bootstrap] prompt dispatch to ${sid.slice(0, 8)} failed: ${msg}`);
              });
            }
          }, 8_000);
        }

        writeJson(res, 201, { project: spec.project, cwd: spec.cwd, spawned });
      } catch (err) {
        writeJson(res, 500, {
          error: 'prd_bootstrap_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    const match = matchSessionRoute(pathname);
    if (match) {
      const record = manager.get(match.sessionId);
      if (!record && match.suffix !== '') {
        writeJson(res, 404, { error: 'session_not_found', session_id: match.sessionId });
        return;
      }

      // DELETE /api/sessions/:id  — kill_session
      if (method === 'DELETE' && match.suffix === '') {
        if (!record) {
          writeJson(res, 404, { error: 'session_not_found', session_id: match.sessionId });
          return;
        }
        manager.kill(match.sessionId);
        writeJson(res, 200, { killed: match.sessionId });
        return;
      }

      // GET /api/sessions/:id  — detail
      if (method === 'GET' && match.suffix === '') {
        if (!record) {
          writeJson(res, 404, { error: 'session_not_found', session_id: match.sessionId });
          return;
        }
        writeJson(res, 200, record);
        return;
      }

      // GET /api/sessions/:id/output?lines=N  — read_output
      if (method === 'GET' && match.suffix === 'output') {
        const linesStr = query.get('lines');
        const requested = linesStr ? Number.parseInt(linesStr, 10) : 100;
        const lines = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 100, 500));
        const tail = manager.scrollbackTail(match.sessionId, lines);
        writeJson(res, 200, { session_id: match.sessionId, lines: tail });
        return;
      }

      // GET /api/sessions/:id/status  — get_status
      if (method === 'GET' && match.suffix === 'status') {
        const detail = manager.statusDetail(match.sessionId);
        if (!detail) {
          writeJson(res, 404, { error: 'session_not_found', session_id: match.sessionId });
          return;
        }
        const ctxPercent = getLastCtxPercent(match.sessionId);
        writeJson(res, 200, { ...detail, ctxPercent, record });
        return;
      }

      // POST /api/sessions/:id/prompt  {text}  — send_prompt
      if (method === 'POST' && match.suffix === 'prompt') {
        try {
          const body = (await readJsonBody(req)) as { text?: unknown };
          if (typeof body.text !== 'string' || body.text.length === 0) {
            writeJson(res, 400, { error: 'invalid_body', detail: 'text (non-empty string) required' });
            return;
          }
          // Write text + \r. node-pty is reliable, unlike wezterm-cli, so a
          // single write with a trailing \r is enough — no triple-redundancy.
          manager.write(match.sessionId, `${body.text}\r`);
          writeJson(res, 200, { session_id: match.sessionId, sent: body.text.length + 1 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, 400, { error: 'send_failed', detail: msg });
        }
        return;
      }

      // POST /api/sessions/:id/key  {key}  — send_key
      if (method === 'POST' && match.suffix === 'key') {
        try {
          const body = (await readJsonBody(req)) as { key?: unknown };
          if (typeof body.key !== 'string' || body.key.length === 0) {
            writeJson(res, 400, { error: 'invalid_body', detail: 'key (non-empty string) required' });
            return;
          }
          const bytes = keyAliasToBytes(body.key);
          manager.write(match.sessionId, bytes);
          writeJson(res, 200, { session_id: match.sessionId, key: body.key, bytes: bytes.length });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, 400, { error: 'send_failed', detail: msg });
        }
        return;
      }

      // POST /api/sessions/:id/title  {title}  — set_tab_title
      if (method === 'POST' && match.suffix === 'title') {
        try {
          const body = (await readJsonBody(req)) as { title?: unknown };
          if (typeof body.title !== 'string') {
            writeJson(res, 400, { error: 'invalid_body', detail: 'title (string) required' });
            return;
          }
          const ok = manager.setTabTitle(match.sessionId, body.title);
          if (!ok) {
            writeJson(res, 404, { error: 'session_not_found', session_id: match.sessionId });
            return;
          }
          writeJson(res, 200, { session_id: match.sessionId, title: body.title });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, 400, { error: 'rename_failed', detail: msg });
        }
        return;
      }

      // GET/POST/DELETE /api/sessions/:id/queue — per-pane prompt queue (Q+).
      if (match.suffix === 'queue') {
        if (method === 'GET') {
          writeJson(res, 200, queueStore.snapshot(match.sessionId));
          return;
        }
        if (method === 'POST') {
          try {
            const body = (await readJsonBody(req)) as { text?: unknown; drain?: unknown };
            if (body.drain === true) {
              const drained = queueStore.drainOne(manager, match.sessionId);
              writeJson(res, 200, { drained, snapshot: queueStore.snapshot(match.sessionId) });
              return;
            }
            const text = typeof body.text === 'string' ? body.text : '';
            const snap = queueStore.enqueue(match.sessionId, text);
            writeJson(res, 201, snap);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            writeJson(res, 400, { error: 'queue_enqueue_failed', detail: msg });
          }
          return;
        }
        if (method === 'DELETE') {
          writeJson(res, 200, queueStore.clear(match.sessionId));
          return;
        }
      }

      // POST /api/sessions/:id/inject-context — gather rendered tails from
      // other live panes and send as a single prompt.
      if (method === 'POST' && match.suffix === 'inject-context') {
        try {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const result = injectContext(manager, match.sessionId, body);
          writeJson(res, 200, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = /required|not found/i.test(msg) ? 400 : 500;
          writeJson(res, code, { error: 'inject_context_failed', detail: msg });
        }
        return;
      }

      // POST /api/sessions/:id/auto-handoff  {focus?, force?, timeouts?}  — Phase 4
      if (method === 'POST' && match.suffix === 'auto-handoff') {
        try {
          const body = (await readJsonBody(req)) as {
            focus?: unknown;
            force?: unknown;
            timeouts?: unknown;
          };
          const focus = typeof body.focus === 'string' ? body.focus : undefined;
          const force = body.force === true;
          const timeouts =
            body.timeouts && typeof body.timeouts === 'object'
              ? (body.timeouts as Partial<AutoHandoffTimeouts>)
              : undefined;
          const result = await runAutoHandoff(manager, bus, match.sessionId, {
            ...(focus !== undefined ? { focus } : {}),
            force,
            ...(timeouts ? { timeouts } : {}),
          });
          switch (result.status) {
            case 'completed':
              writeJson(res, 200, result);
              return;
            case 'not_found':
              writeJson(res, 404, { error: 'session_not_found', session_id: match.sessionId });
              return;
            case 'pane_working':
            case 'not_ready':
              writeJson(res, 409, result);
              return;
            case 'readiness_timeout':
            case 'generation_timeout':
              writeJson(res, 504, result);
              return;
            case 'incomplete_file':
              writeJson(res, 500, result);
              return;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, 500, { error: 'auto_handoff_failed', detail: msg });
        }
        return;
      }

      // POST /api/sessions/:id/wait-idle  {max_wait_s, poll_interval_s}  — wait_for_idle
      if (method === 'POST' && match.suffix === 'wait-idle') {
        try {
          const body = (await readJsonBody(req)) as {
            max_wait_s?: unknown;
            poll_interval_s?: unknown;
          };
          const maxWaitS = Math.min(
            Math.max(Number(body.max_wait_s) || 120, 1),
            600,
          );
          const pollS = Math.min(
            Math.max(Number(body.poll_interval_s) || 3, 1),
            30,
          );
          const deadline = Date.now() + maxWaitS * 1000;
          let timedOut = true;
          while (Date.now() < deadline) {
            const status = manager.status(match.sessionId);
            if (status === 'idle' || status === 'exited') {
              timedOut = false;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, pollS * 1000));
          }
          const detail = manager.statusDetail(match.sessionId);
          writeJson(res, 200, {
            session_id: match.sessionId,
            timed_out: timedOut,
            status: detail?.status ?? 'exited',
            last_lines: detail?.lastLines ?? [],
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, 400, { error: 'wait_failed', detail: msg });
        }
        return;
      }

      writeJson(res, 405, { error: 'method_not_allowed', detail: `${method} ${pathname}` });
      return;
    }

    // Static-serve built frontend from dist/frontend/ as the last resort.
    if (await tryServeStatic(req, res)) return;

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS });
    res.end('not found');
  };
}

function sendServerMessage(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(msg));
}

function parseClientMessage(raw: string): ClientMessage | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'not_an_object' };
  const obj = parsed as Record<string, unknown>;
  if (obj.type === 'ping') return { type: 'ping' };
  if (obj.type === 'input' && typeof obj.data === 'string') {
    return { type: 'input', data: obj.data };
  }
  if (
    obj.type === 'resize' &&
    typeof obj.cols === 'number' &&
    typeof obj.rows === 'number'
  ) {
    return { type: 'resize', cols: obj.cols, rows: obj.rows };
  }
  return { error: 'unknown_message_shape' };
}

function attachSocket(manager: PtyManager, socket: WebSocket, sessionId: SessionId): void {
  const record = manager.get(sessionId);
  if (!record) {
    sendServerMessage(socket, { type: 'error', reason: 'session_not_found' });
    socket.close(1008, 'session_not_found');
    return;
  }

  // Hello + scrollback replay.
  sendServerMessage(socket, {
    type: 'hello',
    session: record,
    scrollback: manager.scrollback(sessionId),
  });

  const onData = (evt: PtyDataEvent): void => {
    if (evt.sessionId !== sessionId) return;
    sendServerMessage(socket, { type: 'data', data: evt.data });
  };
  const onExit = (evt: PtyExitEvent): void => {
    if (evt.sessionId !== sessionId) return;
    sendServerMessage(socket, { type: 'exit', code: evt.code, signal: evt.signal });
    socket.close(1000, 'pty_exit');
  };
  manager.on('data', onData);
  manager.on('exit', onExit);

  socket.on('message', (raw) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
    const msg = parseClientMessage(text);
    if ('error' in msg) {
      sendServerMessage(socket, { type: 'error', reason: msg.error });
      return;
    }
    switch (msg.type) {
      case 'input':
        manager.write(sessionId, msg.data);
        return;
      case 'resize':
        manager.resize(sessionId, msg.cols, msg.rows);
        return;
      case 'ping':
        sendServerMessage(socket, { type: 'pong' });
        return;
    }
  });

  const cleanup = (): void => {
    manager.off('data', onData);
    manager.off('exit', onExit);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

function extractSessionId(pathname: string): SessionId | null {
  if (!pathname.startsWith(WS_PATH_PREFIX)) return null;
  const id = pathname.slice(WS_PATH_PREFIX.length);
  if (id.length === 0 || id.includes('/')) return null;
  return id;
}

export interface StartServerOptions {
  port?: number;
  bus?: EventBus;
  chat?: ChatStore;
  auth?: AuthStore;
  queueStore?: PaneQueueStore;
  dashboard?: DashboardController;
  advisor?: LlmAdvisor;
  decisionLog?: DecisionLog;
}

export async function startServer(
  manager: PtyManager,
  portOrOpts?: number | StartServerOptions,
): Promise<{
  server: http.Server;
  bus: EventBus;
  setChat: (chat: ChatStore) => void;
  setDashboard: (d: DashboardController) => void;
  setAdvisor: (a: LlmAdvisor) => void;
  setDecisionLog: (l: DecisionLog) => void;
  auth: AuthStore | null;
}> {
  const opts: StartServerOptions =
    typeof portOrOpts === 'number' ? { port: portOrOpts } : portOrOpts ?? {};
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const bus = opts.bus ?? new EventBus();
  const auth = opts.auth ?? null;
  // Chat + dashboard are optional — orchestrator attaches them later via
  // setChat / setDashboard. The route handler checks the captured variable
  // at call time (via closure).
  let chatRef: ChatStore | null = opts.chat ?? null;
  const setChat = (c: ChatStore): void => {
    chatRef = c;
  };
  let dashboardRef: DashboardController | null = opts.dashboard ?? null;
  const setDashboard = (d: DashboardController): void => {
    dashboardRef = d;
  };
  let advisorRef: LlmAdvisor | null = opts.advisor ?? null;
  const setAdvisor = (a: LlmAdvisor): void => {
    advisorRef = a;
  };
  let decisionLogRef: DecisionLog | null = opts.decisionLog ?? null;
  const setDecisionLog = (l: DecisionLog): void => {
    decisionLogRef = l;
  };
  const queueStore = opts.queueStore ?? new PaneQueueStore();
  queueStore.attach(bus, manager);
  const server = http.createServer(
    makeHttpHandler(
      manager,
      bus,
      () => chatRef,
      auth,
      queueStore,
      () => dashboardRef,
      () => advisorRef,
      () => decisionLogRef,
    ),
  );
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '';
    const pathname = rawUrl.split('?')[0] ?? '';

    // Auth check on the WS upgrade. Accept either an Authorization header
    // (not always possible for WebSocket in browsers) or a ?token=<t> query.
    if (auth) {
      const headerToken = extractBearerFromHeader(
        (req.headers.authorization ?? req.headers.Authorization) as string | undefined,
      );
      const urlToken = headerToken ? null : extractTokenFromUrl(rawUrl);
      if (!auth.verify(headerToken ?? urlToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    const sessionId = extractSessionId(pathname);
    if (!sessionId) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!manager.get(sessionId)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSocket(manager, ws, sessionId);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, () => {
      server.off('error', onError);
      resolve();
    });
  });

  return { server, bus, setChat, setDashboard, setAdvisor, setDecisionLog, auth };
}
