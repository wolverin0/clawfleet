/**
 * Phase 8 + Phase 9 gate — chat endpoints + bearer-token auth.
 *
 * In-process boots a fresh backend on an ephemeral port with auth enabled,
 * exercises every endpoint with/without bearer, and rotates the token.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PtyManager } from '../src/backend/pty-manager.js';
import { startServer } from '../src/backend/ws-server.js';
import { startOrchestrator } from '../src/backend/orchestrator/executor.js';
import { AuthStore } from '../src/backend/auth.js';

interface Check {
  name: string;
  run: () => Promise<string>;
}

async function runChecks(checks: Check[]): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const check of checks) {
    try {
      const info = await check.run();
      console.log(`[PASS] ${check.name}${info ? ` — ${info}` : ''}`);
      passed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[FAIL] ${check.name} — ${msg}`);
      failed += 1;
    }
  }
  console.log('');
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'theorchestra-phase89-'));
  const tokenPath = path.join(tmp, 'token.json');
  const decisionsDir = path.join(tmp, '_orchestrator');

  const auth = new AuthStore(tokenPath);
  const initialToken = auth.generate();

  const manager = new PtyManager();
  const { server, bus, setChat } = await startServer(manager, { port: 0, auth });
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) throw new Error('no address');
  const base = `http://127.0.0.1:${addr.port}`;

  // Orchestrator + chat (Phase 7 carry-over).
  const orch = startOrchestrator(manager, bus, { decisionsDir });
  setChat(orch.chat);

  const authHeaders = (token: string) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  });

  const checks: Check[] = [
    // ─── Phase 9 — auth gate ───
    {
      name: '9.1 GET /api/health is un-gated (no bearer → 200)',
      run: async () => {
        const r = await fetch(`${base}/api/health`);
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
        return 'ok';
      },
    },
    {
      name: '9.2 GET /api/sessions without bearer → 401',
      run: async () => {
        const r = await fetch(`${base}/api/sessions`);
        if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
        return '401';
      },
    },
    {
      name: '9.3 GET /api/sessions with wrong bearer → 401',
      run: async () => {
        const r = await fetch(`${base}/api/sessions`, {
          headers: { Authorization: 'Bearer not-the-real-token' },
        });
        if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
        return '401';
      },
    },
    {
      name: '9.4 GET /api/sessions with correct bearer → 200',
      run: async () => {
        const r = await fetch(`${base}/api/sessions`, {
          headers: { Authorization: `Bearer ${initialToken}` },
        });
        if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
        return 'array';
      },
    },
    {
      name: '9.5 GET /api/auth/status returns required:true, initialized:true',
      run: async () => {
        const r = await fetch(`${base}/api/auth/status`);
        const body = (await r.json()) as { required: boolean; initialized: boolean };
        if (!body.required || !body.initialized) {
          throw new Error(`unexpected status: ${JSON.stringify(body)}`);
        }
        return 'required + initialized';
      },
    },
    {
      name: '9.6 POST /api/auth/rotate without bearer → 401',
      run: async () => {
        const r = await fetch(`${base}/api/auth/rotate`, { method: 'POST' });
        if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
        return '401';
      },
    },
    {
      name: '9.7 POST /api/auth/rotate with bearer → 200 + new token works + old token fails',
      run: async () => {
        const r = await fetch(`${base}/api/auth/rotate`, {
          method: 'POST',
          headers: authHeaders(initialToken),
        });
        if (r.status !== 200) throw new Error(`rotate expected 200, got ${r.status}`);
        const body = (await r.json()) as { token: string };
        if (!body.token || body.token === initialToken) {
          throw new Error('rotate returned same or empty token');
        }
        // Old token now fails:
        const oldCheck = await fetch(`${base}/api/sessions`, {
          headers: { Authorization: `Bearer ${initialToken}` },
        });
        if (oldCheck.status !== 401) {
          throw new Error(`old token should 401 after rotate, got ${oldCheck.status}`);
        }
        // New token works:
        const newCheck = await fetch(`${base}/api/sessions`, {
          headers: { Authorization: `Bearer ${body.token}` },
        });
        if (newCheck.status !== 200) {
          throw new Error(`new token should 200, got ${newCheck.status}`);
        }
        // Store the new token for subsequent checks.
        (globalThis as { __tkn?: string }).__tkn = body.token;
        return 'rotated + validated';
      },
    },

    // ─── Phase 8 — chat endpoints ───
    {
      name: '8.1 GET /api/chat/messages returns {messages: []}',
      run: async () => {
        const tkn = (globalThis as { __tkn?: string }).__tkn!;
        const r = await fetch(`${base}/api/chat/messages`, {
          headers: { Authorization: `Bearer ${tkn}` },
        });
        const body = (await r.json()) as { messages: unknown[] };
        if (!Array.isArray(body.messages)) throw new Error('messages not array');
        return `${body.messages.length} message(s) initially`;
      },
    },
    {
      name: '8.2 Orchestrator chat.ask appears in /api/chat/messages',
      run: async () => {
        orch.chat.ask(null, 'gate', 'phase89-gate test ask');
        const tkn = (globalThis as { __tkn?: string }).__tkn!;
        const r = await fetch(`${base}/api/chat/messages`, {
          headers: { Authorization: `Bearer ${tkn}` },
        });
        const body = (await r.json()) as {
          messages: Array<{ from: string; topic: string; text: string; id: string }>;
        };
        const match = body.messages.find((m) => m.text === 'phase89-gate test ask');
        if (!match) throw new Error('ask not visible to GET');
        if (match.from !== 'orchestrator') throw new Error(`wrong from: ${match.from}`);
        (globalThis as { __askId?: string }).__askId = match.id;
        return `topic=${match.topic} id=${match.id.slice(0, 8)}…`;
      },
    },
    {
      name: '8.3 POST /api/chat/answer resolves the ask',
      run: async () => {
        const askId = (globalThis as { __askId?: string }).__askId!;
        const tkn = (globalThis as { __tkn?: string }).__tkn!;
        const r = await fetch(`${base}/api/chat/answer`, {
          method: 'POST',
          headers: authHeaders(tkn),
          body: JSON.stringify({ in_reply_to: askId, text: 'acknowledged' }),
        });
        if (r.status !== 201) throw new Error(`answer expected 201, got ${r.status}`);
        // Check the ask now has resolvedAt set.
        const msgs = orch.chat.list();
        const ask = msgs.find((m) => m.id === askId);
        if (!ask?.resolvedAt) throw new Error('ask.resolvedAt not set');
        return `resolvedAt=${ask.resolvedAt}`;
      },
    },
    {
      name: '8.4 POST /api/chat/ask (user-initiated) records user message',
      run: async () => {
        const tkn = (globalThis as { __tkn?: string }).__tkn!;
        const r = await fetch(`${base}/api/chat/ask`, {
          method: 'POST',
          headers: authHeaders(tkn),
          body: JSON.stringify({ text: 'standalone user message' }),
        });
        if (r.status !== 201) throw new Error(`expected 201, got ${r.status}`);
        const body = (await r.json()) as { from: string; text: string };
        if (body.from !== 'user' || body.text !== 'standalone user message') {
          throw new Error(`bad body: ${JSON.stringify(body)}`);
        }
        return 'user message recorded';
      },
    },

    // ─── Phase 9 — WS auth ───
    {
      name: '9.8 WS upgrade without token → 401 (server drops the socket)',
      run: async () => {
        const spawned = await fetch(`${base}/api/sessions`, {
          method: 'POST',
          headers: authHeaders((globalThis as { __tkn?: string }).__tkn!),
          body: JSON.stringify({
            cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
            args: [],
            cwd: process.cwd(),
            tabTitle: 'auth-ws',
          }),
        }).then((r) => r.json() as Promise<{ sessionId: string }>);
        const WebSocket = (await import('ws')).default;
        const url = `ws://127.0.0.1:${addr.port}/ws/pty/${spawned.sessionId}`;
        const ws = new WebSocket(url);
        const result = await new Promise<'rejected' | 'opened'>((resolve) => {
          ws.on('open', () => resolve('opened'));
          ws.on('error', () => resolve('rejected'));
          ws.on('unexpected-response', () => resolve('rejected'));
          setTimeout(() => resolve('rejected'), 2000);
        });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        manager.kill(spawned.sessionId);
        if (result !== 'rejected') throw new Error('WS connected without auth');
        return 'rejected as expected';
      },
    },
    {
      name: '9.9 WS upgrade with ?token=<valid> → opens',
      run: async () => {
        const spawned = await fetch(`${base}/api/sessions`, {
          method: 'POST',
          headers: authHeaders((globalThis as { __tkn?: string }).__tkn!),
          body: JSON.stringify({
            cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
            args: [],
            cwd: process.cwd(),
            tabTitle: 'auth-ws-ok',
          }),
        }).then((r) => r.json() as Promise<{ sessionId: string }>);
        const tkn = (globalThis as { __tkn?: string }).__tkn!;
        const WebSocket = (await import('ws')).default;
        const url = `ws://127.0.0.1:${addr.port}/ws/pty/${spawned.sessionId}?token=${encodeURIComponent(tkn)}`;
        const ws = new WebSocket(url);
        const result = await new Promise<'opened' | 'rejected'>((resolve) => {
          ws.on('open', () => resolve('opened'));
          ws.on('error', () => resolve('rejected'));
          setTimeout(() => resolve('rejected'), 2000);
        });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        manager.kill(spawned.sessionId);
        if (result !== 'opened') throw new Error('WS did not open with valid token');
        return 'opened';
      },
    },
  ];

  await runChecks(checks);

  // Cleanup
  orch.stop();
  server.close();
  manager.killAll();
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  setTimeout(() => process.exit(0), 500).unref();
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack : err);
  process.exit(1);
});
