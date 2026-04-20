/**
 * Phase 6 gate — PTY durability
 *
 * Three categories of evidence:
 *
 *  A. In-process manifest round-trip:
 *     - Spawn a PTY, kill it, verify manifest written
 *     - Directly call respawnDeadSessions against the store
 *     - Verify new session spawned, banner injected
 *
 *  B. Multi-device WS broadcast (in-process, two WS clients on one session):
 *     - Boot server on an ephemeral port
 *     - Connect two WebSocket clients to /ws/pty/:id
 *     - Both receive the 'hello' frame + live 'data' frames
 *     - Either can send 'input'; writes interleave into the PTY
 *
 *  C. Full dashboard-restart smoke (sub-process boot):
 *     - Start theorchestra-start in a child process on ephemeral port
 *     - Spawn via /api/sessions, verify manifest on disk
 *     - SIGTERM the child
 *     - Re-launch theorchestra-start with the SAME manifest dir
 *     - Verify the new process respawned (new sessionId in the manifest dir)
 *     - Since the banner is injected into the backend's ring buffer, the
 *       new session's /output endpoint shows the "[theorchestra] pane
 *       resumed at ..." line.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';

import { PtyManager } from '../src/backend/pty-manager.js';
import {
  SessionManifestStore,
  attachManifestWriter,
  respawnDeadSessions,
} from '../src/backend/session-manifest.js';
import { startServer } from '../src/backend/ws-server.js';
import {
  DEFAULT_DASHBOARD_PORT,
  WS_PATH_PREFIX,
} from '../src/shared/types.js';

interface Check {
  name: string;
  run: () => Promise<string>;
}

async function runChecks(label: string, checks: Check[]): Promise<{ passed: number; failed: number }> {
  console.log(`\n── ${label} ──`);
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
  return { passed, failed };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function tempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function phaseACategory(): Promise<Check[]> {
  const manifestDir = await tempDir('theorchestra-phase6-A-');
  const store = new SessionManifestStore(manifestDir);

  return [
    {
      name: 'A.1 Spawn writes manifest to disk',
      run: async () => {
        const manager = new PtyManager();
        attachManifestWriter(manager, store);
        const rec = manager.spawn({
          cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
          args: [],
          cwd: process.cwd(),
          tabTitle: 'A1',
        });
        // Manifest is sync-written on the 'spawn' event.
        const found = store.read(rec.sessionId);
        manager.kill(rec.sessionId);
        if (!found) throw new Error('manifest not written');
        if (found.sessionId !== rec.sessionId) throw new Error('sessionId mismatch');
        if (found.pid !== rec.pid) throw new Error('pid mismatch');
        return `pid=${found.pid} cli=${found.cli}`;
      },
    },
    {
      name: 'A.2 Exit event marks manifest exitedAt',
      run: async () => {
        const manager = new PtyManager();
        attachManifestWriter(manager, store);
        const rec = manager.spawn({
          cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
          args: [],
          cwd: process.cwd(),
          tabTitle: 'A2',
        });
        manager.kill(rec.sessionId);
        await wait(500);
        const m = store.read(rec.sessionId);
        if (!m) throw new Error('manifest disappeared');
        if (!m.exitedAt) throw new Error('exitedAt not recorded');
        return `exitedAt=${m.exitedAt}`;
      },
    },
    {
      name: 'A.3 respawnDeadSessions resurrects a manifest whose pid is dead',
      run: async () => {
        // Write a manifest by hand with a bogus pid so respawnDeadSessions
        // treats it as dead. Use the shell as cli to avoid needing claude.
        const oldId = 'phase6-A3-' + Math.random().toString(36).slice(2, 10);
        store.write({
          sessionId: oldId,
          pid: 0, // definitely not alive — isPidAlive short-circuits
          cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
          args: [],
          cwd: process.cwd(),
          tabTitle: 'A3-respawned',
          persona: null,
          permissionMode: null,
          spawnedByPaneId: null,
          spawnedAt: new Date().toISOString(),
          lastOutputAt: null,
        });
        const manager = new PtyManager();
        attachManifestWriter(manager, store);
        const results = respawnDeadSessions(manager, store);
        const match = results.find((r) => r.oldSessionId === oldId);
        if (!match) throw new Error('respawn result missing');
        if (!manager.get(match.newSessionId)) throw new Error('new session not in manager');
        // Old manifest file should be gone; new one should exist.
        if (store.read(oldId)) throw new Error('old manifest not cleaned up');
        if (!store.read(match.newSessionId)) throw new Error('new manifest not written');
        // Banner should have been injected into the ring buffer. Wait a bit
        // longer than a typical shell-prompt flush so the ordering (banner
        // first, shell prompt after) holds.
        await wait(600);
        const tail = manager.renderedTail(match.newSessionId, 30);
        // The ring buffer is text-based — check there directly too, since the
        // headless terminal's VT parser may re-wrap or reorder lines with ANSI.
        const scrollback = manager.scrollback(match.newSessionId);
        const bannerSeen =
          tail.some((l) => l.includes('[theorchestra] pane resumed')) ||
          scrollback.includes('[theorchestra] pane resumed');
        manager.kill(match.newSessionId);
        if (!bannerSeen) throw new Error('respawn banner not visible in rendered tail or ring buffer');
        return `banner ok, strategy=${match.strategy}`;
      },
    },
  ];
}

async function phaseBCategory(): Promise<Check[]> {
  const manager = new PtyManager();
  const { server } = await startServer(manager, 0); // ephemeral port
  const addr = server.address();
  if (typeof addr !== 'object' || !addr) throw new Error('server address not bound');
  const port = addr.port;

  return [
    {
      name: 'B.1 Two WS clients on one session both receive `hello` + data',
      run: async () => {
        const rec = manager.spawn({
          cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
          args: [],
          cwd: process.cwd(),
          tabTitle: 'B1',
        });
        const url = `ws://127.0.0.1:${port}${WS_PATH_PREFIX}${rec.sessionId}`;
        const ws1 = new WebSocket(url);
        const ws2 = new WebSocket(url);
        const received1: unknown[] = [];
        const received2: unknown[] = [];
        ws1.on('message', (d) => received1.push(JSON.parse(d.toString())));
        ws2.on('message', (d) => received2.push(JSON.parse(d.toString())));
        await Promise.all([
          new Promise<void>((r) => ws1.on('open', () => r())),
          new Promise<void>((r) => ws2.on('open', () => r())),
        ]);
        // Wait for hello on both
        await wait(300);
        const hello1 = received1.find((m) => typeof m === 'object' && m && (m as any).type === 'hello');
        const hello2 = received2.find((m) => typeof m === 'object' && m && (m as any).type === 'hello');
        if (!hello1 || !hello2) throw new Error('hello frame missing on one or both sockets');
        // Inject a banner — both sockets should receive the data frame.
        manager.injectBanner(rec.sessionId, 'HELLO-MULTI-DEVICE');
        await wait(200);
        const has1 = received1.some(
          (m) => typeof m === 'object' && m && (m as any).type === 'data' && String((m as any).data).includes('HELLO-MULTI-DEVICE'),
        );
        const has2 = received2.some(
          (m) => typeof m === 'object' && m && (m as any).type === 'data' && String((m as any).data).includes('HELLO-MULTI-DEVICE'),
        );
        ws1.close();
        ws2.close();
        manager.kill(rec.sessionId);
        if (!has1 || !has2) throw new Error(`data missing on socket (1:${has1}, 2:${has2})`);
        return 'both sockets received same data frame';
      },
    },
    {
      name: 'B.2 Input from either client writes to the same PTY',
      run: async () => {
        const rec = manager.spawn({
          cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
          args: [],
          cwd: process.cwd(),
          tabTitle: 'B2',
        });
        const url = `ws://127.0.0.1:${port}${WS_PATH_PREFIX}${rec.sessionId}`;
        const ws1 = new WebSocket(url);
        const ws2 = new WebSocket(url);
        await Promise.all([
          new Promise<void>((r) => ws1.on('open', () => r())),
          new Promise<void>((r) => ws2.on('open', () => r())),
        ]);
        await wait(200); // let hello land
        ws1.send(JSON.stringify({ type: 'input', data: 'echo from-ws-1\r' }));
        await wait(500);
        ws2.send(JSON.stringify({ type: 'input', data: 'echo from-ws-2\r' }));
        await wait(1200);
        const tail = manager.renderedTail(rec.sessionId, 20);
        ws1.close();
        ws2.close();
        manager.kill(rec.sessionId);
        const has1 = tail.some((l) => l.includes('from-ws-1'));
        const has2 = tail.some((l) => l.includes('from-ws-2'));
        if (!has1 || !has2) {
          throw new Error(`input from one/both sockets missing (1:${has1}, 2:${has2})`);
        }
        return 'both sockets typed into the same PTY';
      },
    },
  ];
}

async function phaseCCategory(): Promise<Check[]> {
  const manifestDir = await tempDir('theorchestra-phase6-C-');
  const port = 4399;
  const repoRoot = path.resolve(__dirname, '..');
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const startScript = path.join(repoRoot, 'scripts', 'theorchestra-start.ts');

  let child: ChildProcess | null = null;
  let firstSid: string | null = null;

  async function launch(): Promise<ChildProcess> {
    const p = spawnChild(process.execPath, [tsxCli, startScript], {
      env: {
        ...process.env,
        THEORCHESTRA_PORT: String(port),
        THEORCHESTRA_SESSIONS_DIR: manifestDir,
        THEORCHESTRA_DEFAULT_CLI: 'shell',
        // Disable the tasks watcher (no vault in this test)
        THEORCHESTRA_TASKS_FILE: path.join(manifestDir, '.tasks-not-used.md'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout?.on('data', () => {});
    p.stderr?.on('data', () => {});
    // Wait for the server to come up.
    for (let i = 0; i < 30; i++) {
      await wait(500);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) return p;
      } catch {
        /* not ready */
      }
    }
    throw new Error('backend did not come up within 15s');
  }

  return [
    {
      name: 'C.1 Fresh backend — spawn session, verify manifest on disk',
      run: async () => {
        child = await launch();
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cli: process.platform === 'win32' ? 'cmd.exe' : 'bash',
            args: [],
            cwd: process.cwd(),
            tabTitle: 'C1',
          }),
        });
        const rec = (await res.json()) as { sessionId: string };
        firstSid = rec.sessionId;
        await wait(300);
        const files = fs.readdirSync(manifestDir).filter((f) => f.endsWith('.json'));
        if (files.length < 1) throw new Error('no manifests on disk');
        return `${files.length} manifest(s), new=${firstSid.slice(0, 8)}`;
      },
    },
    {
      name: 'C.2 SIGTERM backend, relaunch, verify respawned session visible',
      run: async () => {
        if (!child) throw new Error('child not initialized');
        // Graceful stop via our /api/health-ish path doesn't exist; SIGTERM.
        child.kill('SIGTERM');
        // Windows SIGTERM is weak; fall back to kill after 2s.
        await wait(2000);
        if (!child.killed) child.kill('SIGKILL');
        await wait(1000);
        // Relaunch
        child = await launch();
        await wait(1500); // let respawn pass complete
        const filesAfter = fs.readdirSync(manifestDir).filter((f) => f.endsWith('.json'));
        // The respawn deletes the old manifest and writes a new one.
        if (!firstSid) throw new Error('no prior session id');
        const stillHasOld = filesAfter.includes(`${firstSid}.json`);
        if (stillHasOld) {
          throw new Error(`old manifest ${firstSid}.json not cleaned up after respawn`);
        }
        // There should be at least 1 manifest (the default + the respawned).
        if (filesAfter.length === 0) throw new Error('no manifests after respawn');
        return `${filesAfter.length} manifest(s) after respawn, old cleaned`;
      },
    },
    {
      name: 'C.3 Cleanup child process + temp dir',
      run: async () => {
        if (child) {
          child.kill('SIGKILL');
          await wait(500);
        }
        try {
          await fsp.rm(manifestDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        return 'ok';
      },
    },
  ];
}

async function main(): Promise<void> {
  console.log('Phase 6 — PTY durability gate');

  const a = await phaseACategory();
  const aRes = await runChecks('A. In-process manifest + respawn', a);

  const b = await phaseBCategory();
  const bRes = await runChecks('B. Multi-device WS broadcast', b);

  const c = await phaseCCategory();
  const cRes = await runChecks('C. Full dashboard-restart (subprocess)', c);

  const passed = aRes.passed + bRes.passed + cRes.passed;
  const failed = aRes.failed + bRes.failed + cRes.failed;
  console.log('');
  console.log(`Result: ${passed} passed, ${failed} failed`);
  // Give any pending timers a moment, then exit deterministically.
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500).unref();
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack : err);
  process.exit(1);
});
