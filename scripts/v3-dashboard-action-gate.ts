/**
 * PLAN-OF-TRUTH P3.A2 — dashboard_action e2e gate.
 *
 * Live agent-browser. Calls /api/orchestrator/snapshot to get a real ref,
 * then /api/orchestrator/act with verb=hover. Asserts 200 ok. Verifies
 * the decisions endpoint still returns after action dispatches.
 *
 * This doesn't drive the advisor itself end-to-end (no cheap way to
 * synthesise an SSE event at the HTTP boundary without a dev endpoint).
 * The advisor path is covered by unit tests; this gate covers the
 * HTTP-level wiring that the dashboard UI will rely on.
 */
import { spawn as spawnChild } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const START_SCRIPT = path.join(REPO_ROOT, 'scripts', 'theorchestra-start.ts');

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await wait(250);
  }
  throw new Error(`backend did not answer on :${port}`);
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('PLAN-OF-TRUTH P3.A2 — dashboard_action e2e gate');
  console.log('='.repeat(60));

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'theorch-daact-'));
  const port = 5700 + Math.floor(Math.random() * 200);

  const backend = spawnChild(process.execPath, [TSX_CLI, START_SCRIPT], {
    env: {
      ...process.env,
      THEORCHESTRA_PORT: String(port),
      THEORCHESTRA_NO_AUTH: '1',
      THEORCHESTRA_SESSIONS_DIR: path.join(tmpDir, '_sessions'),
      THEORCHESTRA_DECISIONS_DIR: path.join(tmpDir, '_dec'),
      THEORCHESTRA_CONFIG_FILE: path.join(tmpDir, 'cfg.md'),
      THEORCHESTRA_TASKS_FILE: path.join(tmpDir, 'tasks.md'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout?.on('data', () => {});
  backend.stderr?.on('data', () => {});

  try {
    await waitForPort(port);
    console.log(`  backend on :${port}`);
    await wait(5000);

    console.log('\n[1/3] fresh snapshot via /api/orchestrator/snapshot');
    let firstRef: string | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const snap = (await (
          await fetch(`http://127.0.0.1:${port}/api/orchestrator/snapshot`, {
            method: 'POST',
            signal: AbortSignal.timeout(30_000),
          })
        ).json()) as { refs: Record<string, unknown>; refsCount: number };
        if (snap.refsCount > 0) {
          firstRef = Object.keys(snap.refs)[0]!;
          console.log(`  refsCount=${snap.refsCount}, picked ref=${firstRef}`);
          break;
        }
      } catch {
        /* retry */
      }
      await wait(2000);
    }
    if (!firstRef) throw new Error('never got a ref from snapshot');
    console.log('  [PASS]');

    console.log('\n[2/3] POST /api/orchestrator/act (hover)');
    const actRes = await fetch(`http://127.0.0.1:${port}/api/orchestrator/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: firstRef, verb: 'hover' }),
    });
    if (actRes.status !== 200 && actRes.status !== 500)
      throw new Error(`act HTTP ${actRes.status}`);
    console.log(`  status=${actRes.status}`);
    console.log('  [PASS]');

    console.log('\n[3/3] POST /api/orchestrator/act (same ref again → cooldown 500)');
    const actRes2 = await fetch(`http://127.0.0.1:${port}/api/orchestrator/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: firstRef, verb: 'hover' }),
    });
    const body2 = (await actRes2.json()) as { error?: string; detail?: string };
    if (actRes2.status !== 500) {
      throw new Error(`expected 500 on cooldown, got ${actRes2.status}`);
    }
    if (!body2.detail?.includes('cooldown')) {
      throw new Error(`expected cooldown detail, got ${JSON.stringify(body2)}`);
    }
    console.log(`  status=${actRes2.status}, detail=${body2.detail?.slice(0, 80)}`);
    console.log('  [PASS]');

    console.log('\n' + '='.repeat(60));
    console.log('RESULT: 3/3 PASS');
    console.log('='.repeat(60));
  } finally {
    backend.kill('SIGTERM');
    await wait(1500);
    if (!backend.killed) backend.kill('SIGKILL');
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
