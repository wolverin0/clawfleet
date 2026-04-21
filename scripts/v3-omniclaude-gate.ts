/**
 * PLAN-OF-TRUTH P7.G2 — omniclaude e2e gate.
 *
 * Skips if `claude` isn't on PATH. Otherwise:
 *   1. Boot backend with THEORCHESTRA_OMNICLAUDE=1 + fresh vault dir.
 *   2. Verify GET /api/orchestrator/omniclaude reports enabled=true +
 *      returns the session record.
 *   3. Verify GET /api/sessions filters omniclaude out by default.
 *   4. Verify GET /api/sessions?include_omni=1 includes it.
 *   5. Publish a synthetic event (by spawning a user pane and hitting
 *      ctx_threshold is too slow; instead we verify omniclaude can be
 *      reached: GET its output and confirm bytes are flowing).
 */
import { spawn as spawnChild } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const START_SCRIPT = path.join(REPO_ROOT, 'scripts', 'theorchestra-start.ts');

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function claudeOnPath(): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return;
    } catch {
      /* */
    }
    await wait(250);
  }
  throw new Error(`backend did not answer on :${port}`);
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('PLAN-OF-TRUTH P7.G2 — omniclaude e2e gate');
  console.log('='.repeat(60));

  if (!claudeOnPath()) {
    console.log('[SKIP] `claude` not on PATH');
    process.exit(0);
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'theorch-omni-'));
  const omniDir = path.join(tmpDir, '_omniclaude');
  await fsp.mkdir(omniDir, { recursive: true });
  // Copy the real CLAUDE.md so omniclaude knows its role even in the tmp dir.
  const srcClaude = path.resolve(REPO_ROOT, 'vault', '_omniclaude', 'CLAUDE.md');
  await fsp.copyFile(srcClaude, path.join(omniDir, 'CLAUDE.md'));
  const port = 6000 + Math.floor(Math.random() * 100);

  const backend = spawnChild(process.execPath, [TSX_CLI, START_SCRIPT], {
    env: {
      ...process.env,
      THEORCHESTRA_PORT: String(port),
      THEORCHESTRA_NO_AUTH: '1',
      THEORCHESTRA_OMNICLAUDE: '1',
      THEORCHESTRA_NO_DASHBOARD_SNAPSHOT: '1',
      THEORCHESTRA_SESSIONS_DIR: path.join(tmpDir, '_sessions'),
      THEORCHESTRA_DECISIONS_DIR: path.join(tmpDir, '_dec'),
      THEORCHESTRA_CONFIG_FILE: path.join(tmpDir, 'cfg.md'),
      THEORCHESTRA_TASKS_FILE: path.join(tmpDir, 'tasks.md'),
      // Point omniclaude at the copied dir.
      THEORCHESTRA_OMNICLAUDE_CWD: omniDir,
    },
    cwd: tmpDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logLines: string[] = [];
  backend.stdout?.on('data', (d) => logLines.push(d.toString()));
  backend.stderr?.on('data', (d) => logLines.push(d.toString()));

  try {
    await waitForPort(port);
    console.log(`  backend on :${port}`);
    // Give the driver time to spawn omniclaude pane.
    await wait(3000);

    console.log('\n[1/4] GET /api/orchestrator/omniclaude');
    const omniRes = await fetch(`http://127.0.0.1:${port}/api/orchestrator/omniclaude`);
    if (!omniRes.ok) throw new Error(`HTTP ${omniRes.status}`);
    const omni = (await omniRes.json()) as {
      enabled: boolean;
      session: { sessionId: string } | null;
    };
    if (!omni.enabled) {
      console.log('---backend log tail---');
      console.log(logLines.join('').slice(-3000));
      throw new Error('omniclaude not enabled');
    }
    if (!omni.session) {
      console.log('---backend log tail---');
      console.log(logLines.join('').slice(-3000));
      throw new Error('omniclaude session not materialised');
    }
    const omniSid = omni.session.sessionId;
    console.log(`  omniclaude sid=${omniSid.slice(0, 8)}`);
    console.log('  [PASS]');

    console.log('\n[2/4] GET /api/sessions (default, filtered)');
    const s1 = (await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json()) as Array<{
      sessionId: string;
    }>;
    if (s1.some((r) => r.sessionId === omniSid)) {
      throw new Error('default /api/sessions leaked omniclaude sid');
    }
    console.log(`  ${s1.length} sessions returned (omniclaude hidden)`);
    console.log('  [PASS]');

    console.log('\n[3/4] GET /api/sessions?include_omni=1');
    const s2 = (await (
      await fetch(`http://127.0.0.1:${port}/api/sessions?include_omni=1`)
    ).json()) as Array<{ sessionId: string }>;
    if (!s2.some((r) => r.sessionId === omniSid)) {
      throw new Error('?include_omni=1 did NOT include omniclaude sid');
    }
    console.log(`  ${s2.length} sessions returned (omniclaude included)`);
    console.log('  [PASS]');

    console.log('\n[4/4] read output from omniclaude pane — any bytes?');
    // Claude takes a few seconds to launch. Poll for up to 15s.
    let bytes = 0;
    for (let i = 0; i < 15; i++) {
      const outRes = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${omniSid}/output?lines=30`,
      );
      if (outRes.ok) {
        const body = (await outRes.json()) as { lines: string[] };
        bytes = (body.lines ?? []).join('').length;
        if (bytes > 20) break;
      }
      await wait(1000);
    }
    if (bytes === 0) throw new Error('omniclaude pane produced no output within 15s');
    console.log(`  ${bytes} bytes streamed from omniclaude pane`);
    console.log('  [PASS]');

    console.log('\n' + '='.repeat(60));
    console.log('RESULT: 4/4 PASS');
    console.log('='.repeat(60));
  } finally {
    backend.kill('SIGTERM');
    await wait(2000);
    if (!backend.killed) backend.kill('SIGKILL');
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});

// Note: backend stdio is captured into logLines for diagnostics. On unhandled
// error the `finally` still runs so we SIGTERM the subprocess. To dump on
// failure we'd need to promote logLines scope; pragmatic path is to run this
// script with `DEBUG=1` in CI to print on every run.
