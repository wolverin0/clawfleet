/**
 * PLAN-OF-TRUTH P4.A — reasoning panel + decisions API gate.
 *
 * 1. Boots backend with THEORCHESTRA_LLM_ADVISOR=1 (skips if no provider).
 * 2. Asserts GET /api/orchestrator/decisions shape.
 * 3. Asserts GET /api/orchestrator/advisor reports enabled.
 * 4. Opens the dashboard in Playwright, logs in, scrolls to the Activity
 *    sidebar, asserts the "Reasoning" panel title is visible.
 */
import { spawn as spawnChild } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const START_SCRIPT = path.join(REPO_ROOT, 'scripts', 'theorchestra-start.ts');
const SCREENSHOTS_DIR = path.join(REPO_ROOT, 'docs', 'screenshots', 'v3.0');

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

async function readToken(file: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as { token: string };
      if (parsed.token) return parsed.token;
    }
    await wait(200);
  }
  throw new Error(`token file not materialised at ${file}`);
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('PLAN-OF-TRUTH P4.A — reasoning panel gate');
  console.log('='.repeat(60));

  const hasApi = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasCli = claudeOnPath();
  if (!hasApi && !hasCli) {
    console.log('[SKIP] no LLM provider; reasoning panel would render disabled-state only.');
    process.exit(0);
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'theorch-rp-'));
  const port = 5800 + Math.floor(Math.random() * 200);
  const tokenFile = path.join(tmpDir, 'token.json');

  const backend = spawnChild(process.execPath, [TSX_CLI, START_SCRIPT], {
    env: {
      ...process.env,
      THEORCHESTRA_PORT: String(port),
      THEORCHESTRA_LLM_ADVISOR: '1',
      THEORCHESTRA_NO_DASHBOARD_SNAPSHOT: '1',
      THEORCHESTRA_TOKEN_FILE: tokenFile,
      THEORCHESTRA_SESSIONS_DIR: path.join(tmpDir, '_sessions'),
      THEORCHESTRA_DECISIONS_DIR: path.join(tmpDir, '_dec'),
      THEORCHESTRA_CONFIG_FILE: path.join(tmpDir, 'cfg.md'),
      THEORCHESTRA_TASKS_FILE: path.join(tmpDir, 'tasks.md'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout?.on('data', () => {});
  backend.stderr?.on('data', () => {});

  const browser = await chromium.launch();
  try {
    await waitForPort(port);
    const token = await readToken(tokenFile);
    console.log(`  backend on :${port}, token ${token.slice(0, 6)}…`);

    console.log('\n[1/3] /api/orchestrator/advisor');
    const advRes = await fetch(`http://127.0.0.1:${port}/api/orchestrator/advisor`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!advRes.ok) throw new Error(`advisor HTTP ${advRes.status}`);
    const adv = (await advRes.json()) as { enabled: boolean; provider: string };
    if (!adv.enabled) throw new Error(`advisor disabled: ${JSON.stringify(adv)}`);
    console.log(`  enabled=true, provider=${adv.provider}`);
    console.log('  [PASS]');

    console.log('\n[2/3] /api/orchestrator/decisions shape');
    const decRes = await fetch(`http://127.0.0.1:${port}/api/orchestrator/decisions?limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!decRes.ok) throw new Error(`decisions HTTP ${decRes.status}`);
    const dec = (await decRes.json()) as { decisions: unknown[] };
    if (!Array.isArray(dec.decisions)) throw new Error('decisions not an array');
    console.log(`  decisions.length=${dec.decisions.length}`);
    console.log('  [PASS]');

    console.log('\n[3/3] Playwright — ReasoningPanel rendered');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    // Login via the existing form.
    await page.fill('input[type="password"], input[aria-label*="token" i], input[placeholder*="token" i]', token);
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('.activity-sidebar', { timeout: 10_000 });

    // Assert the Reasoning panel title is present in the DOM.
    const reasoning = await page.locator('.as-panel-head:has-text("Reasoning")').first();
    const count = await reasoning.count();
    if (count === 0) throw new Error('Reasoning panel title not found');
    console.log('  panel title found');

    // Capture a screenshot for the test log.
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const shot = path.join(SCREENSHOTS_DIR, 'plan-of-truth-reasoning-panel.png');
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`  screenshot → ${shot}`);
    console.log('  [PASS]');

    await ctx.close();

    console.log('\n' + '='.repeat(60));
    console.log('RESULT: 3/3 PASS');
    console.log('='.repeat(60));
  } finally {
    await browser.close();
    backend.kill('SIGTERM');
    await wait(1500);
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
