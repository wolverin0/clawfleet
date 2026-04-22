/**
 * PLAN-OF-TRUTH P10 — project-briefer behavior gate.
 *
 * Verifies the "context hygiene" loop:
 *   1. ~/.claude/agents/project-briefer.md is a valid agent definition
 *   2. omniclaude, when told to brief itself on a fixture project, calls
 *      the Task subagent and quotes content from the fixture in its
 *      DECISION line — proving the briefer actually ran + its output
 *      landed in omniclaude's context.
 *
 * Standalone run:
 *     npx tsx scripts/v3-briefer-behavior-gate.ts
 *
 * Preserve artifacts:
 *     KEEP_ARTIFACTS=1 npx tsx scripts/v3-briefer-behavior-gate.ts
 */
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const START_SCRIPT = path.join(REPO_ROOT, 'scripts', 'theorchestra-start.ts');
const FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'testproject-briefer-probe');
const BRIEFER_AGENT = path.join(os.homedir(), '.claude', 'agents', 'project-briefer.md');

type Verdict = 'PASS' | 'FAIL' | 'SKIP';
interface ScenarioResult {
  name: string;
  verdict: Verdict;
  detail: string;
  seconds: number;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function claudeOnPath(): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    stdio: 'ignore',
  });
  return r.status === 0;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function waitForPort(port: number, token: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await wait(250);
  }
  throw new Error(`backend did not answer on :${port}`);
}

async function waitForTokenFile(tokenFile: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fsp.readFile(tokenFile, 'utf-8');
      const parsed = JSON.parse(raw) as { token?: string };
      if (typeof parsed.token === 'string' && parsed.token.length > 0) return parsed.token;
    } catch {
      /* not ready */
    }
    await wait(200);
  }
  throw new Error(`token file never materialised at ${tokenFile}`);
}

async function waitForOmniclaudeSid(
  port: number,
  token: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/orchestrator/omniclaude`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        const body = (await r.json()) as {
          enabled?: boolean;
          session?: { sessionId?: string } | null;
        };
        if (body.enabled && body.session && typeof body.session.sessionId === 'string') {
          return body.session.sessionId;
        }
      }
    } catch {
      /* retry */
    }
    await wait(500);
  }
  throw new Error('omniclaude session never materialised');
}

async function tellOmni(port: number, token: string, text: string): Promise<void> {
  const r = await fetch(`http://127.0.0.1:${port}/api/orchestrator/tell-omni`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`POST tell-omni → HTTP ${r.status} ${body}`);
  }
}

// ─── SCENARIO 1 — briefer agent file parses ────────────────────────────────

async function scenarioAgentFileValid(): Promise<ScenarioResult> {
  const name = '1 — project-briefer agent file parses';
  const t0 = Date.now();
  try {
    const raw = await fsp.readFile(BRIEFER_AGENT, 'utf-8');
    const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      return {
        name,
        verdict: 'FAIL',
        detail: `no YAML frontmatter found in ${BRIEFER_AGENT}`,
        seconds: (Date.now() - t0) / 1000,
      };
    }
    const fm = frontmatterMatch[1]!;
    const body = frontmatterMatch[2]!;
    const requiredKeys = ['name:', 'description:', 'tools:'];
    const missing = requiredKeys.filter((k) => !fm.includes(k));
    if (missing.length > 0) {
      return {
        name,
        verdict: 'FAIL',
        detail: `frontmatter missing ${missing.join(', ')}`,
        seconds: (Date.now() - t0) / 1000,
      };
    }
    if (!fm.includes('name: project-briefer')) {
      return {
        name,
        verdict: 'FAIL',
        detail: `name field is not "project-briefer"`,
        seconds: (Date.now() - t0) / 1000,
      };
    }
    if (body.trim().length < 200) {
      return {
        name,
        verdict: 'FAIL',
        detail: `body too short (<200 chars) — prompt is probably empty`,
        seconds: (Date.now() - t0) / 1000,
      };
    }
    return {
      name,
      verdict: 'PASS',
      detail: `agent file valid (${raw.length} bytes, body ${body.length} chars)`,
      seconds: (Date.now() - t0) / 1000,
    };
  } catch (err) {
    return {
      name,
      verdict: 'FAIL',
      detail: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      seconds: (Date.now() - t0) / 1000,
    };
  }
}

// ─── SCENARIO 2 — omniclaude calls briefer + quotes fixture content ─────────

async function scenarioOmniCallsBriefer(
  port: number,
  token: string,
  decisionsDir: string,
): Promise<ScenarioResult> {
  const name = '2 — omniclaude calls briefer, cites fixture content';
  const t0 = Date.now();

  const fixturePath = FIXTURE_DIR.replace(/\\/g, '/');
  // Prompt deliberately does NOT include fixture tokens as examples —
  // otherwise omniclaude can pass by parroting the example back. The briefer
  // must have actually run and produced a real briefing for the DECISION line
  // to include a real fixture token.
  const prompt = `Mission: use the project-briefer subagent to brief yourself on the project at ${fixturePath}.

Call Task({ subagent_type: "project-briefer", description: "brief on testproject-briefer-probe", prompt: "Project root: ${fixturePath}\\nReason: briefer-gate probe — identify stack + key files + active issues." }).

Once the briefing returns, read its content. Then emit ONE DECISION line of this shape:
  DECISION: briefer-ran - testproject-briefer-probe: <exact-issue-id>

Where <exact-issue-id> is the issue ID you find under "Active issues" in the returned briefing. The ID is a single hyphenated token (format: LETTERS-DIGITS). Do NOT paste a placeholder. Do NOT paste angle brackets. Do NOT guess — only cite what the briefer actually returned.

Then stop.`;

  try {
    await tellOmni(port, token, prompt);
  } catch (err) {
    return {
      name,
      verdict: 'FAIL',
      detail: `tell-omni failed: ${err instanceof Error ? err.message : String(err)}`,
      seconds: (Date.now() - t0) / 1000,
    };
  }

  // Poll decisions log for up to 4 min. The ONLY acceptable pass is a DECISION
  // line whose reason quotes the exact issue ID from monitoring.md (AUTH-001).
  // Reject lines containing placeholder fragments like "<", "quote", "e.g.",
  // "exact-issue-id" — those signal omniclaude echoed the prompt template
  // instead of actually running the briefer.
  const deadline = Date.now() + 4 * 60 * 1000;
  const issueIdToken = /\bAUTH-001\b/;
  const projectToken = /testproject-briefer-probe/;
  const placeholderLeak = /<exact-issue-id>|<quote|placeholder|e\.g\./i;

  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(decisionsDir, `decisions-${today}.md`);

  while (Date.now() < deadline) {
    await wait(10_000);
    try {
      const raw = await fsp.readFile(logPath, 'utf-8');
      const lines = raw.split('\n');
      for (const line of lines) {
        if (!line.includes('omniclaude_decision')) continue;
        if (!projectToken.test(line)) continue;
        if (placeholderLeak.test(line)) continue; // template echo, not a real briefing citation
        if (issueIdToken.test(line)) {
          return {
            name,
            verdict: 'PASS',
            detail: `decision log cites AUTH-001 from fixture monitoring.md — briefer pathway verified`,
            seconds: (Date.now() - t0) / 1000,
          };
        }
      }
    } catch {
      /* not ready yet */
    }
  }

  return {
    name,
    verdict: 'FAIL',
    detail: `no DECISION line cited AUTH-001 (without placeholder leak) in 4min — briefer may not have actually run`,
    seconds: (Date.now() - t0) / 1000,
  };
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('PLAN-OF-TRUTH P10 — project-briefer behavior gate');
  console.log('='.repeat(72));

  if (!claudeOnPath()) {
    console.log('[SKIP] `claude` not on PATH — briefer gate requires live omniclaude');
    process.exit(0);
  }

  const results: ScenarioResult[] = [];

  console.log('\n[1/2] briefer agent file parses...');
  const r1 = await scenarioAgentFileValid();
  results.push(r1);
  console.log(`  [${r1.verdict}] ${r1.detail} (${r1.seconds.toFixed(1)}s)`);

  if (r1.verdict !== 'PASS') {
    console.log('\n[SKIP 2/2] agent file invalid — downstream scenarios skipped');
    results.push({
      name: '2 — omniclaude calls briefer',
      verdict: 'SKIP',
      detail: 'scenario 1 did not pass',
      seconds: 0,
    });
    printSummary(results);
    process.exit(1);
  }

  // Spin up isolated backend for scenario 2.
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'theorch-briefer-'));
  const omniDir = path.join(tmpDir, '_omniclaude');
  await fsp.mkdir(omniDir, { recursive: true });
  const srcClaude = path.resolve(REPO_ROOT, 'vault', '_omniclaude', 'CLAUDE.md');
  await fsp.copyFile(srcClaude, path.join(omniDir, 'CLAUDE.md'));

  const tokenFile = path.join(tmpDir, 'token.json');
  const sessionsDir = path.join(tmpDir, '_sessions');
  const decisionsDir = path.join(tmpDir, '_dec');
  const configFile = path.join(tmpDir, 'cfg.md');
  const tasksFile = path.join(tmpDir, 'tasks.md');
  const port = 6500 + Math.floor(Math.random() * 200);

  const backend = spawnChild(process.execPath, [TSX_CLI, START_SCRIPT], {
    env: {
      ...process.env,
      THEORCHESTRA_PORT: String(port),
      THEORCHESTRA_OMNICLAUDE: '1',
      THEORCHESTRA_NO_KILL_ON_SHUTDOWN: '1',
      THEORCHESTRA_NO_DASHBOARD_SNAPSHOT: '1',
      THEORCHESTRA_TOKEN_FILE: tokenFile,
      THEORCHESTRA_SESSIONS_DIR: sessionsDir,
      THEORCHESTRA_DECISIONS_DIR: decisionsDir,
      THEORCHESTRA_CONFIG_FILE: configFile,
      THEORCHESTRA_TASKS_FILE: tasksFile,
      THEORCHESTRA_OMNICLAUDE_CWD: omniDir,
    },
    cwd: tmpDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logLines: string[] = [];
  backend.stdout?.on('data', (d: Buffer) => logLines.push(d.toString()));
  backend.stderr?.on('data', (d: Buffer) => logLines.push(d.toString()));

  try {
    const token = await waitForTokenFile(tokenFile);
    await waitForPort(port, token);
    console.log(`  backend on :${port}`);
    const omniSid = await waitForOmniclaudeSid(port, token);
    console.log(`  omniclaude sid=${omniSid.slice(0, 8)}`);
    await wait(5000);

    console.log('\n[2/2] omniclaude calls briefer + cites fixture...');
    const r2 = await scenarioOmniCallsBriefer(port, token, decisionsDir);
    results.push(r2);
    console.log(`  [${r2.verdict}] ${r2.detail} (${r2.seconds.toFixed(1)}s)`);
  } catch (err) {
    console.error('[FATAL harness error]', err instanceof Error ? err.stack ?? err.message : err);
    console.error('---backend log tail---');
    console.error(logLines.join('').slice(-3000));
    results.push({
      name: '2 — omniclaude calls briefer',
      verdict: 'FAIL',
      detail: `harness error: ${err instanceof Error ? err.message : String(err)}`,
      seconds: 0,
    });
  } finally {
    try {
      backend.kill('SIGTERM');
    } catch {
      /* */
    }
    await wait(2000);
    if (!backend.killed) {
      try {
        backend.kill('SIGKILL');
      } catch {
        /* */
      }
    }
    if (process.env.KEEP_ARTIFACTS === '1') {
      console.log(`\n[harness] keeping tmpDir: ${tmpDir}`);
    } else {
      try {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  }

  printSummary(results);
  const fail = results.filter((r) => r.verdict === 'FAIL').length;
  if (fail > 0) process.exit(1);
}

function printSummary(results: ScenarioResult[]): void {
  console.log('\n' + '='.repeat(72));
  console.log('RESULT TABLE');
  console.log('='.repeat(72));
  const pad = (s: string, n: number): string => s.padEnd(n, ' ');
  console.log(`${pad('scenario', 50)} ${pad('result', 6)} ${pad('seconds', 8)} detail`);
  console.log('-'.repeat(72));
  for (const r of results) {
    console.log(`${pad(r.name, 50)} ${pad(r.verdict, 6)} ${pad(r.seconds.toFixed(1), 8)} ${r.detail}`);
  }
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const skip = results.filter((r) => r.verdict === 'SKIP').length;
  const fail = results.filter((r) => r.verdict === 'FAIL').length;
  console.log('-'.repeat(72));
  console.log(`PASS=${pass} SKIP=${skip} FAIL=${fail}`);
  console.log('='.repeat(72));
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
