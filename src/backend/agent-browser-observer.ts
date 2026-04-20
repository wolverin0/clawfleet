/**
 * agent-browser observation layer (REMEDIATION step 6).
 *
 * Spawns the vercel-labs/agent-browser CLI to observe the dashboard
 * DOM + a11y tree. Returns structured snapshots with semantic element
 * refs (`@e1`, `@e2`, …) that orchestrator / omniclaude code can pass
 * back to agent-browser for actions (click, type, snapshot, etc.).
 *
 * This replaces the @xterm/headless VT-parse path for high-level
 * observation. @xterm/headless stays for the low-level SSE emitters
 * (status-bar %, permission prompts) — those are per-line regex scans
 * on raw PTY bytes, different use case.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AB_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'agent-browser.cmd');

interface RunOptions {
  /** Session name — agent-browser multiplexes multiple browsers by name. */
  session?: string;
  timeoutMs?: number;
}

/** Run one agent-browser command. Returns stdout; rejects with stderr on nonzero. */
function runAb(args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullArgs = opts.session ? ['--session', opts.session, ...args] : args;
    // Windows: node_modules/.bin/agent-browser is a .cmd wrapper. `spawn`
    // needs `shell: true` to exec it, but then doesn't auto-quote a bin
    // path containing spaces ("Py Apps"). Solution: build the full
    // quoted command string ourselves and hand it to cmd.exe.
    const quoted = [AB_BIN, ...fullArgs]
      .map((a) => (a.includes(' ') ? `"${a}"` : a))
      .join(' ');
    const child = spawn(quoted, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`agent-browser ${fullArgs.join(' ')} timed out`));
    }, opts.timeoutMs ?? 30_000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`agent-browser exit ${code}: ${stderr || stdout}`));
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export interface AbSnapshotResult {
  /** Raw a11y-tree JSON exactly as agent-browser returned it. */
  tree: unknown;
  /** ms elapsed. */
  latencyMs: number;
}

export interface AbObserverOptions {
  /** Dashboard URL (including `?token=<t>` if auth is enabled). */
  dashboardUrl: string;
  /** Named agent-browser session so we don't fight with user sessions. */
  session?: string;
}

/**
 * Open the dashboard once (if not already open in this session), then
 * return a semantic-locator snapshot. Interactive-only + compact so
 * orchestrator consumers get a tight tree.
 */
export async function snapshotDashboard(
  opts: AbObserverOptions,
): Promise<AbSnapshotResult> {
  const session = opts.session ?? 'theorchestra';
  // Ensure navigation — `open` is idempotent if the URL is already loaded.
  await runAb(['open', opts.dashboardUrl], { session, timeoutMs: 20_000 });
  const t0 = Date.now();
  const raw = await runAb(['snapshot', '-i', '-c', '--json'], { session });
  const latencyMs = Date.now() - t0;
  return { tree: JSON.parse(raw), latencyMs };
}

/**
 * Perform one semantic action (click, fill, etc.) against a ref emitted
 * by a prior snapshot. `ref` is the `@eN` token agent-browser returned.
 */
export async function actOnRef(
  ref: string,
  action: 'click' | 'dblclick' | 'focus' | 'hover',
  opts: AbObserverOptions,
): Promise<void> {
  const session = opts.session ?? 'theorchestra';
  await runAb([action, ref], { session, timeoutMs: 10_000 });
}

/**
 * Close the named agent-browser session (shuts down the headless
 * Chrome for that session). Call on shutdown.
 */
export async function closeObserver(session = 'theorchestra'): Promise<void> {
  try {
    await runAb(['close'], { session, timeoutMs: 5000 });
  } catch {
    /* already closed / never opened — fine */
  }
}
