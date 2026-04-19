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

function makeHttpHandler(manager: PtyManager) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'OPTIONS' && url.startsWith('/api/')) {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (method === 'GET' && url === '/api/health') {
      writeJson(res, 200, { ok: true, version: VERSION });
      return;
    }

    if (method === 'GET' && url === '/api/sessions') {
      writeJson(res, 200, manager.list());
      return;
    }

    if (method === 'POST' && url === '/api/sessions') {
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

export async function startServer(
  manager: PtyManager,
  port: number = DEFAULT_DASHBOARD_PORT,
): Promise<http.Server> {
  const server = http.createServer(makeHttpHandler(manager));
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

  return server;
}
