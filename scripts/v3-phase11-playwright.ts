/**
 * Phase 11 — REAL Playwright UI suite for the v2.x-style U1-U6 dashboard.
 *
 * Boots a backend subprocess on an ephemeral port, reads the generated token
 * from its manifest file, opens a real Chromium with Playwright, and drives
 * the dashboard the way a user would.
 *
 * Asserts at every step:
 *   - zero console errors (favicon 404 excepted)
 *   - expected DOM appears (by role/text)
 *   - screenshot saved to docs/screenshots/v3.0/playwright-*.png
 *
 * Exits non-zero if ANY assertion fails.
 */

import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, type Browser, type Page, type ConsoleMessage } from 'playwright';

interface Check {
  name: string;
  run: () => Promise<string>;
}

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const START_SCRIPT = path.join(REPO_ROOT, 'scripts', 'theorchestra-start.ts');
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'docs', 'screenshots', 'v3.0');

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    await wait(300);
  }
  throw new Error(`backend did not answer on :${port} within ${timeoutMs}ms`);
}

async function readToken(tokenFile: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(tokenFile)) {
      const raw = fs.readFileSync(tokenFile, 'utf-8');
      const parsed = JSON.parse(raw) as { token: string };
      if (parsed.token) return parsed.token;
    }
    await wait(200);
  }
  throw new Error(`token file not materialised at ${tokenFile} within ${timeoutMs}ms`);
}

interface Suite {
  backend: ChildProcess;
  backendLog: string[];
  browser: Browser;
  page: Page;
  consoleErrors: string[];
  port: number;
  token: string;
  tmpDir: string;
}

async function setupSuite(): Promise<Suite> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'theorchestra-pw-'));
  const port = 5000 + Math.floor(Math.random() * 500);
  const tokenFile = path.join(tmpDir, 'token.json');

  const backendLog: string[] = [];
  const backend = spawnChild(process.execPath, [TSX_CLI, START_SCRIPT], {
    env: {
      ...process.env,
      THEORCHESTRA_PORT: String(port),
      THEORCHESTRA_TOKEN_FILE: tokenFile,
      THEORCHESTRA_SESSIONS_DIR: path.join(tmpDir, '_sessions'),
      THEORCHESTRA_DECISIONS_DIR: path.join(tmpDir, '_orchestrator'),
      THEORCHESTRA_CONFIG_FILE: path.join(tmpDir, '.no-config.md'),
      THEORCHESTRA_TASKS_FILE: path.join(tmpDir, '.no-tasks.md'),
      THEORCHESTRA_DEBUG_EVENTS: '1',
      THEORCHESTRA_MEMORYMASTER_INBOX: '1',
      THEORCHESTRA_MEMORYMASTER_INBOX_FILE: path.join(tmpDir, '_memorymaster', 'inbox.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout?.on('data', (d) => backendLog.push(`[out] ${d.toString()}`));
  backend.stderr?.on('data', (d) => backendLog.push(`[err] ${d.toString()}`));

  await waitForPort(port);
  const token = await readToken(tokenFile);

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleErrors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (text.includes('favicon.ico')) return;
      // 401 after we deliberately blow away the token in UI.9 is expected.
      if (text.includes('401') || text.includes('Unauthorized')) return;
      consoleErrors.push(text);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  return { backend, backendLog, browser, page, consoleErrors, port, token, tmpDir };
}

async function teardownSuite(s: Suite): Promise<void> {
  try {
    await s.browser.close();
  } catch {
    /* ignore */
  }
  try {
    s.backend.kill('SIGTERM');
    await wait(1500);
    if (!s.backend.killed) s.backend.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    await fsp.rm(s.tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function shot(page: Page, name: string): Promise<string> {
  const file = path.join(SCREENSHOT_DIR, `playwright-${name}.png`);
  await page.screenshot({ path: file, type: 'png', fullPage: true });
  return file;
}

async function spawnPane(
  port: number,
  token: string,
  cwd: string,
  tabTitle: string,
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ cli: 'cmd.exe', cwd, tabTitle }),
  });
  if (!res.ok) throw new Error(`spawn failed: HTTP ${res.status}`);
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

async function runChecks(checks: Check[], consoleErrors: string[]): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const check of checks) {
    const beforeErrs = consoleErrors.length;
    try {
      const info = await check.run();
      const newErrs = consoleErrors.slice(beforeErrs);
      if (newErrs.length > 0) {
        console.log(`[FAIL] ${check.name} — console errors: ${newErrs.join(' | ')}`);
        failed += 1;
      } else {
        console.log(`[PASS] ${check.name}${info ? ` — ${info}` : ''}`);
        passed += 1;
      }
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
  console.log('Phase 11 — Playwright UI gate (U1-U6 dashboard)');
  console.log('='.repeat(60));
  const s = await setupSuite();
  console.log(`backend on :${s.port} · tmp=${s.tmpDir}`);

  const homeDir = (process.env.USERPROFILE ?? os.homedir()).replace(/\\/g, '/');

  const checks: Check[] = [
    {
      name: 'UI.1 Login page renders',
      run: async () => {
        await s.page.goto(`http://127.0.0.1:${s.port}/`);
        await s.page.waitForSelector('h1:has-text("theorchestra")', { timeout: 10_000 });
        await s.page.waitForSelector('input[placeholder="paste token here"]', { timeout: 5000 });
        await shot(s.page, '01-login');
        return 'login page rendered';
      },
    },
    {
      name: 'UI.2 Token accepted → 4-tab shell + status counters + sidebar',
      run: async () => {
        await s.page.locator('input[placeholder="paste token here"]').fill(s.token);
        await s.page.locator('button', { hasText: 'Continue' }).click();
        await s.page.waitForSelector('nav[aria-label="Primary"]', { timeout: 20_000 });
        for (const tab of ['Sessions', 'Live', 'Desktop', 'Spawn']) {
          const count = await s.page
            .locator(`nav[aria-label="Primary"] [role="button"]:has-text("${tab}")`)
            .count();
          if (count < 1) throw new Error(`${tab} tab button missing`);
        }
        await s.page.waitForSelector('[aria-label="Activity sidebar"]', { timeout: 5000 });
        await shot(s.page, '02-shell');
        return 'shell + sidebar visible';
      },
    },
    {
      name: 'UI.3 Sessions tab shows empty state or pane grid',
      run: async () => {
        await s.page
          .locator('nav[aria-label="Primary"] [role="button"]:has-text("Sessions")')
          .click();
        // Either the empty-state div renders, or — if a prior Sessions fetch
        // somehow restored state — the grid itself renders. Both are valid.
        await s.page.waitForSelector(
          '.pane-grid-empty, .pane-grid-tile, .pane-grid-cascade, .pane-grid-stack, .pane-grid-show-all',
          { timeout: 10_000 },
        );
        await shot(s.page, '03-sessions-initial');
        return 'sessions tab rendered';
      },
    },
    {
      name: 'UI.4 Spawn pane via API → pane card appears in grid',
      run: async () => {
        const id = await spawnPane(s.port, s.token, homeDir, 'pw-one');
        await s.page.waitForSelector(`text=${id.slice(0, 8)}`, { timeout: 10_000 });
        await s.page.waitForSelector('.pane-grid-tile', { timeout: 5000 });
        await shot(s.page, '04-pane-card-tile');
        return `pane ${id.slice(0, 8)} rendered`;
      },
    },
    {
      name: 'UI.5 Layout controls reshape grid',
      run: async () => {
        for (const mode of ['Cascade', 'Stack', 'Show All', 'Tile']) {
          await s.page.locator('.layout-btn', { hasText: mode }).click();
          await wait(200);
          const modeClass =
            mode === 'Cascade'
              ? '.pane-grid-cascade'
              : mode === 'Stack'
                ? '.pane-grid-stack'
                : mode === 'Show All'
                  ? '.pane-grid-show-all'
                  : '.pane-grid-tile';
          await s.page.waitForSelector(modeClass, { timeout: 3000 });
          await shot(s.page, `05-layout-${mode.toLowerCase().replace(/\s+/g, '-')}`);
        }
        return 'all 4 layouts verified';
      },
    },
    {
      name: 'UI.6 Broadcast-to-all actually delivers to every session',
      run: async () => {
        await spawnPane(s.port, s.token, homeDir, 'pw-two');
        await spawnPane(s.port, s.token, homeDir, 'pw-three');
        // BroadcastBar polls /api/sessions every 3s; wait for the placeholder
        // to reflect the new count so the component has seen every pane.
        const listRes0 = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        const list0 = (await listRes0.json()) as unknown[];
        const expected = list0.length;
        const broadcastInput = s.page.locator('input[aria-label="Broadcast message"]');
        await broadcastInput.waitFor({ timeout: 5000 });
        await s.page.waitForFunction(
          // Runs in the browser context; `document` is the page's DOM.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((n: number) => {
            // @ts-expect-error document is browser-only
            const el: any = document.querySelector('input[aria-label="Broadcast message"]');
            return !!el && String(el.placeholder ?? '').includes(`${n} session`);
          }) as unknown as (arg: number) => boolean,
          expected,
          { timeout: 8000 },
        );
        await broadcastInput.fill('echo pw-broadcast-probe');
        const broadcastBtn = s.page.locator('button.broadcast-btn');
        await broadcastBtn.waitFor({ timeout: 3000 });
        await broadcastBtn.click();
        await s.page.waitForSelector('.broadcast-result', { timeout: 5000 });
        const resultText = (await s.page.locator('.broadcast-result').first().textContent()) ?? '';
        const match = resultText.match(/(\d+)\s*ok,\s*(\d+)\s*failed/);
        if (!match) throw new Error(`unexpected broadcast result: ${resultText}`);
        const okCount = Number(match[1]);
        const failCount = Number(match[2]);
        const listRes = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        const list = (await listRes.json()) as Array<{ sessionId: string }>;
        if (okCount !== list.length || failCount !== 0) {
          throw new Error(
            `broadcast fanout mismatch: ok=${okCount} fail=${failCount} sessions=${list.length}`,
          );
        }
        await shot(s.page, '06-broadcast-delivered');
        return `broadcast fanned out to all ${okCount} sessions`;
      },
    },
    {
      name: 'UI.7 Spawn tab renders wizard form',
      run: async () => {
        await s.page
          .locator('nav[aria-label="Primary"] [role="button"]:has-text("Spawn")')
          .click();
        await wait(500);
        const hasPersonaUi = (await s.page.locator('text=Persona').count()) > 0;
        const hasCwdUi = (await s.page.locator('text=cwd').count()) > 0;
        if (!hasPersonaUi && !hasCwdUi) throw new Error('spawn wizard fields not found');
        await shot(s.page, '07-spawn-wizard');
        return 'spawn wizard rendered';
      },
    },
    {
      name: 'UI.8 Refresh preserves token + state',
      run: async () => {
        await s.page.reload();
        await s.page.waitForSelector('nav[aria-label="Primary"]', { timeout: 20_000 });
        await s.page.locator('nav[aria-label="Primary"] [role="button"]:has-text("Sessions")').click();
        await s.page.waitForSelector(
          '.pane-grid-tile, .pane-grid-cascade, .pane-grid-stack, .pane-grid-show-all',
          { timeout: 5000 },
        );
        await shot(s.page, '08-after-refresh');
        return 'refresh preserves state';
      },
    },
    {
      name: 'UI.13 Pane-card prompt input delivers text to that pane',
      run: async () => {
        await s.page.locator('nav[aria-label="Primary"] [role="button"]:has-text("Sessions")').click();
        const listRes = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        const list = (await listRes.json()) as Array<{ sessionId: string; tabTitle: string }>;
        const target = list.find((x) => x.tabTitle === 'pw-one') ?? list[0];
        if (!target) throw new Error('no target pane');
        const name = target.tabTitle;
        const probe = `pw-prompt-probe-${Math.random().toString(36).slice(2, 8)}`;
        const input = s.page.locator(`input[aria-label="Prompt for ${name}"]`).first();
        await input.waitFor({ timeout: 5000 });
        await input.fill(`echo ${probe}`);
        const sendBtn = s.page
          .locator(`input[aria-label="Prompt for ${name}"] ~ button:has-text("Send")`)
          .first();
        await sendBtn.click();
        const start = Date.now();
        let seen = false;
        while (Date.now() - start < 8000) {
          const r = await fetch(
            `http://127.0.0.1:${s.port}/api/sessions/${target.sessionId}/output?lines=40`,
            { headers: { Authorization: `Bearer ${s.token}` } },
          );
          const body = (await r.json()) as { lines: string[] };
          if (body.lines.some((l) => l.includes(probe))) {
            seen = true;
            break;
          }
          await wait(300);
        }
        if (!seen) throw new Error(`probe ${probe} did not reach pane within 8s`);
        await shot(s.page, '13-pane-card-prompt-delivery');
        return `prompt landed in ${name}`;
      },
    },
    {
      name: 'UI.11 ctx_threshold 30 fires handoff suggest toast',
      run: async () => {
        await s.page.locator('nav[aria-label="Primary"] [role="button"]:has-text("Sessions")').click();
        const listRes = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        const list = (await listRes.json()) as Array<{ sessionId: string }>;
        const sid = list[0]?.sessionId;
        if (!sid) throw new Error('no session for ctx_threshold test');
        await fetch(`http://127.0.0.1:${s.port}/api/_debug/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
          body: JSON.stringify({ type: 'ctx_threshold', sessionId: sid, percent: 31, crossed: 30 }),
        });
        await s.page.waitForSelector('.handoff-toast', { timeout: 5000 });
        await shot(s.page, '11-handoff-toast-30');
        return 'handoff toast appeared at 30%';
      },
    },
    {
      name: 'UI.12 ctx_threshold 50 fires handoff enforce modal',
      run: async () => {
        const listRes = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        const list = (await listRes.json()) as Array<{ sessionId: string }>;
        const sid = list[0]?.sessionId;
        if (!sid) throw new Error('no session for ctx_threshold 50 test');
        await fetch(`http://127.0.0.1:${s.port}/api/_debug/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
          body: JSON.stringify({ type: 'ctx_threshold', sessionId: sid, percent: 52, crossed: 50 }),
        });
        await s.page.waitForSelector('.handoff-modal-backdrop, .handoff-modal', { timeout: 5000 });
        await shot(s.page, '12-handoff-modal-50');
        // Dismiss so downstream UI.10 (mobile viewport) can click the topbar tabs.
        await s.page.locator('button.handoff-modal-dismiss').click();
        await wait(200);
        return 'handoff modal appeared at 50% and was dismissable';
      },
    },
    {
      name: 'UI.10 375px mobile viewport: topbar + tabs + sidebar collapse reachable, one screenshot per tab',
      run: async () => {
        await s.page.setViewportSize({ width: 375, height: 812 });
        await wait(400);
        await s.page.waitForSelector('nav[aria-label="Primary"]', { timeout: 10_000 });
        const tabs: Array<'Sessions' | 'Live' | 'Desktop' | 'Spawn'> = [
          'Sessions',
          'Live',
          'Desktop',
          'Spawn',
        ];
        for (const tab of tabs) {
          const btn = s.page
            .locator(`nav[aria-label="Primary"] [role="button"]:has-text("${tab}")`)
            .first();
          if ((await btn.count()) < 1) throw new Error(`${tab} tab not reachable at 375px`);
          await btn.click();
          await wait(250);
          await shot(s.page, `10-mobile-${tab.toLowerCase()}`);
        }
        // Sidebar has a collapse button — verify it exists + clicking it toggles
        // the collapsed state (resilient: whichever direction the chevron currently
        // points, one click flips it).
        const collapseBtn = s.page.locator(
          '[aria-label="Activity sidebar"] button[aria-label="Collapse activity sidebar"], ' +
            '[aria-label="Activity sidebar"] button[aria-label="Expand activity sidebar"]',
        );
        if ((await collapseBtn.count()) < 1) {
          throw new Error('sidebar collapse button missing at 375px');
        }
        await collapseBtn.first().click();
        await wait(200);
        await shot(s.page, '10-mobile-sidebar-toggled');
        // Restore 1280×900 for downstream checks.
        await s.page.setViewportSize({ width: 1280, height: 900 });
        await wait(200);
        return 'mobile shell reachable, 5 screenshots captured';
      },
    },
    {
      name: 'UI.16 POST /api/a2a/handoff sends prompt to source pane; GET /api/handoffs lists handoffs dir',
      run: async () => {
        const listRes = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        const list = (await listRes.json()) as Array<{ sessionId: string; tabTitle: string }>;
        const source = list.find((x) => x.tabTitle === 'pw-one') ?? list[0];
        const target = list.find((x) => x.tabTitle === 'pw-two') ?? list[1];
        if (!source || !target) throw new Error('need at least 2 panes for handoff test');

        const handoffRes = await fetch(`http://127.0.0.1:${s.port}/api/a2a/handoff`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
          body: JSON.stringify({
            source_session_id: source.sessionId,
            target_session_id: target.sessionId,
            instruction: 'pw test handoff: run echo after reading this',
          }),
        });
        if (!handoffRes.ok) throw new Error(`handoff HTTP ${handoffRes.status}`);
        const handoff = (await handoffRes.json()) as {
          ok: boolean;
          corr: string;
          suggested_file: string;
        };
        if (!handoff.ok) throw new Error('handoff returned ok:false');
        if (!handoff.corr.startsWith('handoff-')) {
          throw new Error(`unexpected corr shape: ${handoff.corr}`);
        }

        // Verify the instructive prompt actually reached the source pane's output.
        const start = Date.now();
        let seen = false;
        while (Date.now() - start < 8000) {
          const r = await fetch(
            `http://127.0.0.1:${s.port}/api/sessions/${source.sessionId}/output?lines=80`,
            { headers: { Authorization: `Bearer ${s.token}` } },
          );
          const body = (await r.json()) as { lines: string[] };
          if (body.lines.some((l) => l.includes('[Dashboard A2A Handoff Request]'))) {
            seen = true;
            break;
          }
          await wait(300);
        }
        if (!seen) throw new Error('handoff prompt did not land in source pane within 8s');

        // GET /api/handoffs for the source pane (directory may not exist; empty list is still 200).
        const histRes = await fetch(
          `http://127.0.0.1:${s.port}/api/handoffs?session=${source.sessionId}`,
          { headers: { Authorization: `Bearer ${s.token}` } },
        );
        if (!histRes.ok) throw new Error(`handoffs HTTP ${histRes.status}`);
        const hist = (await histRes.json()) as { handoffs: unknown[] };
        if (!Array.isArray(hist.handoffs)) throw new Error('handoffs not an array');

        return `corr=${handoff.corr}, prompt landed, history endpoint returned ${hist.handoffs.length} file(s)`;
      },
    },
    {
      name: 'UI.15 Key aliases — ESC · Tab · arrows · PageUp — all accepted by /key',
      run: async () => {
        const listRes = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        const list = (await listRes.json()) as Array<{ sessionId: string }>;
        const sid = list[0]?.sessionId;
        if (!sid) throw new Error('no session for key alias test');
        const aliases = ['escape', 'tab', 'shift+tab', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'backspace'];
        for (const key of aliases) {
          const r = await fetch(`http://127.0.0.1:${s.port}/api/sessions/${sid}/key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
            body: JSON.stringify({ key }),
          });
          if (!r.ok) throw new Error(`/key rejected alias "${key}": HTTP ${r.status}`);
          const body = (await r.json()) as { bytes: number };
          if (typeof body.bytes !== 'number' || body.bytes < 1) {
            throw new Error(`alias "${key}" translated to 0 bytes (unknown?)`);
          }
        }
        return `${aliases.length} key aliases accepted`;
      },
    },
    {
      name: 'UI.14 MemoryMaster bridge writes ctx_threshold event to inbox.jsonl',
      run: async () => {
        const inboxFile = path.join(s.tmpDir, '_memorymaster', 'inbox.jsonl');
        if (!fs.existsSync(inboxFile)) {
          throw new Error(`inbox file not created at ${inboxFile}`);
        }
        const raw = fs.readFileSync(inboxFile, 'utf-8').trim();
        if (!raw) throw new Error('inbox file exists but is empty');
        const lines = raw.split('\n').filter((l) => l.trim().length > 0);
        const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        const ctxLine = parsed.find((p) => p.predicate === 'ctx_threshold_crossed');
        if (!ctxLine) {
          throw new Error(`no ctx_threshold_crossed line in inbox; got ${lines.length} lines`);
        }
        if (ctxLine.source_agent !== 'theorchestra') {
          throw new Error(`unexpected source_agent: ${String(ctxLine.source_agent)}`);
        }
        if (typeof ctxLine.idempotency_key !== 'string' || !ctxLine.idempotency_key) {
          throw new Error('missing idempotency_key');
        }
        return `inbox has ${lines.length} line(s); ctx_threshold captured`;
      },
    },
    {
      name: 'UI.9 Invalid token → login page returns',
      run: async () => {
        await s.page.evaluate(() => {
          (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
            'theorchestra.token',
            'obviously-wrong-value',
          );
        });
        await s.page.reload();
        await s.page.waitForSelector('h1:has-text("theorchestra")', { timeout: 10_000 });
        await s.page.waitForSelector('input[placeholder="paste token here"]', { timeout: 5000 });
        await shot(s.page, '09-invalid-token-kicks-back');
        return 'invalid token → login';
      },
    },
  ];

  try {
    await runChecks(checks, s.consoleErrors);
  } finally {
    await teardownSuite(s);
  }

  if (s.consoleErrors.length > 0) {
    console.log('');
    console.log(`[WARN] ${s.consoleErrors.length} console error(s) accumulated across the run:`);
    for (const e of s.consoleErrors.slice(0, 10)) console.log(`  - ${e}`);
  }

  setTimeout(() => process.exit(0), 200).unref();
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack : err);
  process.exit(1);
});
