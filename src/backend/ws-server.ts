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

/** Translate v2.7-compatible key aliases into byte sequences to write to the PTY. */
function keyAliasToBytes(key: string): string {
  const k = key.toLowerCase();
  switch (k) {
    case 'enter':
      return '\r';
    case 'ctrl+c':
    case 'ctrl-c':
      return '\x03';
    case 'alt+m':
    case 'meta+m':
      return '\x1bm';
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
  suffix: string; // '' | 'output' | 'status' | 'prompt' | 'key' | 'title' | 'wait-idle'
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

function makeHttpHandler(manager: PtyManager, bus: EventBus) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'OPTIONS' && url.startsWith('/api/')) {
      res.writeHead(204, {
        ...CORS_HEADERS,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      });
      res.end();
      return;
    }

    const { pathname, query } = parsePath(url);

    if (method === 'GET' && pathname === '/api/health') {
      writeJson(res, 200, { ok: true, version: VERSION });
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
      writeJson(res, 200, manager.list());
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
        writeJson(res, 200, { ...detail, record });
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
}

export async function startServer(
  manager: PtyManager,
  portOrOpts?: number | StartServerOptions,
): Promise<{ server: http.Server; bus: EventBus }> {
  const opts: StartServerOptions =
    typeof portOrOpts === 'number' ? { port: portOrOpts } : portOrOpts ?? {};
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const bus = opts.bus ?? new EventBus();
  const server = http.createServer(makeHttpHandler(manager, bus));
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '';
    const pathname = rawUrl.split('?')[0] ?? '';
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

  return { server, bus };
}
