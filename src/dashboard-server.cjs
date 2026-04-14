#!/usr/bin/env node
/**
 * theorchestra dashboard server — thin HTTP + SSE layer over wezbridge tooling.
 *
 * Endpoints:
 *   GET  /api/panes                        — current pane list with status, identity, metrics
 *   GET  /api/panes/:id/output?lines=50    — scrollback from a pane
 *   GET  /api/tasks                        — parsed active_tasks.md (if present)
 *   GET  /api/events                       — SSE stream of omni-watcher events
 *   POST /api/panes/:id/prompt  {text}     — send_prompt + send_key(enter)
 *   POST /api/panes/:id/key     {key}      — send_key
 *   POST /api/panes/:id/kill               — kill pane
 *   POST /api/spawn             {cwd,program?} — spawn a new pane
 *
 * Static frontend assets served from ../dashboard/dist (after `npm run build`).
 * Dev mode: run Vite separately on :5173 and set a proxy to this server on :4200.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const wez = require('./wezterm.cjs');
const { discoverPanes } = require('./pane-discovery.cjs');
const { parseTasksFile } = (() => {
  try { return require('./task-parser.cjs'); }
  catch { return { parseTasksFile: () => ({ tasks: [], error: 'task-parser not available' }) }; }
})();

const PORT = parseInt(process.env.DASHBOARD_PORT || '4200', 10);
const STATIC_DIR = path.join(__dirname, '..', 'dashboard', 'dist');
const ACTIVE_TASKS_PATH = process.env.ACTIVE_TASKS_PATH
  || path.join(process.env.OMNICLAUDE_PATH || path.join(__dirname, '..', '..', 'omniclaude'), 'active_tasks.md');

// --- helpers ---
function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', chunk => { buf += chunk; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function log(msg) { process.stderr.write(`[dashboard] ${new Date().toISOString()} ${msg}\n`); }

// --- route handlers ---

async function handleGetPanes(req, res) {
  try {
    // discoverPanes() returns camelCase (paneId, isClaude, projectName, lastLines);
    // map to snake_case to match the wezbridge MCP contract the frontend expects.
    const raw = discoverPanes ? discoverPanes() : wez.listPanes().map(p => ({ paneId: p.pane_id }));
    const panes = (raw || []).map(p => ({
      pane_id: p.paneId ?? p.pane_id,
      is_claude: p.isClaude ?? false,
      status: p.status ?? 'unknown',
      project: p.project ?? null,
      project_name: p.projectName ?? null,
      title: p.title ?? '',
      workspace: p.workspace ?? 'default',
      confidence: p.confidence ?? 0,
      last_line: p.lastLines ?? '',
    }));
    sendJson(res, 200, { panes });
  } catch (err) {
    log(`GET /api/panes error: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGetPaneOutput(res, paneId, lines) {
  try {
    const text = wez.getFullText(paneId, lines);
    sendJson(res, 200, { pane_id: paneId, lines: text || '' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGetTasks(res) {
  try {
    if (!fs.existsSync(ACTIVE_TASKS_PATH)) {
      return sendJson(res, 200, { tasks: [], note: `no active_tasks.md at ${ACTIVE_TASKS_PATH}` });
    }
    const { tasks: tasksMap, errors } = parseTasksFile(ACTIVE_TASKS_PATH);
    const tasks = Array.from(tasksMap.values());
    sendJson(res, 200, { tasks, errors });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// SSE: spawn an omni-watcher child, forward its stdout JSON lines as events.
function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

  const child = spawn(process.execPath, [path.join(__dirname, 'omni-watcher.cjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WATCHER_POLL_MS: process.env.WATCHER_POLL_MS || '30000' },
  });

  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      res.write(`data: ${line}\n\n`);
    }
  });
  child.stderr.on('data', chunk => log(`watcher stderr: ${chunk.toString('utf8').trim()}`));
  child.on('exit', code => {
    res.write(`event: watcher_exit\ndata: ${JSON.stringify({ code })}\n\n`);
    res.end();
  });

  req.on('close', () => {
    child.kill();
  });
}

async function handlePostPrompt(req, res, paneId) {
  try {
    const { text } = await parseBody(req);
    if (typeof text !== 'string' || !text.length) {
      return sendJson(res, 400, { error: 'missing `text` body field' });
    }
    wez.sendText(paneId, text);
    // Auto-follow with enter per the A2A hard rule
    wez.sendTextNoEnter(paneId, '\r');
    sendJson(res, 200, { ok: true, pane_id: paneId });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostKey(req, res, paneId) {
  try {
    const { key } = await parseBody(req);
    if (!key) return sendJson(res, 400, { error: 'missing `key` body field' });
    const mapping = {
      enter: '\r', y: 'y', n: 'n',
      'ctrl+c': '\x03',
      '1': '1', '2': '2', '3': '3',
    };
    const payload = mapping[key.toLowerCase()] ?? key;
    wez.sendTextNoEnter(paneId, payload);
    sendJson(res, 200, { ok: true, pane_id: paneId, key });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostKill(res, paneId) {
  try {
    wez.killPane(paneId);
    sendJson(res, 200, { ok: true, pane_id: paneId });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostSpawn(req, res) {
  try {
    const { cwd, program, args } = await parseBody(req);
    if (!cwd) return sendJson(res, 400, { error: 'missing `cwd` body field' });
    const paneId = wez.spawnPane({ cwd, program, args });
    sendJson(res, 200, { ok: true, pane_id: paneId });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// --- static file serving ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.map':  'application/json',
};

function serveStatic(res, urlPath) {
  if (!fs.existsSync(STATIC_DIR)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('Dashboard not built. Run: cd dashboard && npm install && npm run build');
  }
  let relPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(STATIC_DIR, relPath);
  if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback to index.html
    const idx = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return fs.createReadStream(idx).pipe(res);
    }
    res.writeHead(404); return res.end('not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// --- server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // API routes
  if (pathname === '/api/panes' && method === 'GET') return handleGetPanes(req, res);
  if (pathname === '/api/tasks' && method === 'GET') return handleGetTasks(res);
  if (pathname === '/api/events' && method === 'GET') return handleEvents(req, res);
  if (pathname === '/api/spawn' && method === 'POST') return handlePostSpawn(req, res);

  const paneMatch = pathname.match(/^\/api\/panes\/(\d+)(\/(output|prompt|key|kill))?$/);
  if (paneMatch) {
    const paneId = parseInt(paneMatch[1], 10);
    const sub = paneMatch[3];
    if (sub === 'output' && method === 'GET') {
      const lines = parseInt(url.searchParams.get('lines') || '50', 10);
      return handleGetPaneOutput(res, paneId, lines);
    }
    if (sub === 'prompt' && method === 'POST') return handlePostPrompt(req, res, paneId);
    if (sub === 'key' && method === 'POST')    return handlePostKey(req, res, paneId);
    if (sub === 'kill' && method === 'POST')   return handlePostKill(res, paneId);
  }

  // Static fallthrough (serves the built React SPA)
  if (method === 'GET') return serveStatic(res, pathname);

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  log(`theorchestra dashboard server listening on http://localhost:${PORT}`);
  log(`API: /api/panes, /api/tasks, /api/events (SSE)`);
  log(`Static: ${fs.existsSync(STATIC_DIR) ? STATIC_DIR : '(dashboard not built yet)'}`);
});

process.on('SIGTERM', () => { log('SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { log('SIGINT'); server.close(() => process.exit(0)); });
