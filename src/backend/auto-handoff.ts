/**
 * Auto-handoff — the v3.0 port of v2.7's handlePostAutoHandoff (dashboard-server.cjs
 * lines 716-870). Runs the full 7-step flow:
 *
 *   1. Pre-flight (session exists, not working unless forced).
 *   2. Readiness check (ask the pane; poll for READY/NOT_READY) unless forced.
 *   3. Dispatch the /handoff skill with a deterministic filename.
 *   4. Poll for file existence (size > 200 bytes).
 *   5. Verify the file has at least 2 of the 4 canonical section headers.
 *   6. Wait for the pane to settle (3 consecutive idle reads).
 *   7. Send Ctrl+C, /clear, and a continuation prompt.
 *
 * This module is pure logic — no HTTP concerns. The caller (ws-server) maps
 * the discriminated-union result to HTTP status codes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import type { PtyManager } from './pty-manager.js';
import type { EventBus } from './events.js';
import type { SessionId } from '../shared/types.js';

export interface AutoHandoffOptions {
  focus?: string;
  force?: boolean;
  /** Override timeouts (Phase 4 gate uses shorter values). */
  timeouts?: Partial<AutoHandoffTimeouts>;
}

export interface AutoHandoffTimeouts {
  /** Max wait for READY/NOT_READY reply, in ms. v2.7 default: 120_000. */
  readinessMs: number;
  /** Max wait for the handoff file to appear + exceed 200 bytes, in ms. v2.7 default: 90_000. */
  generationMs: number;
  /** Max wait for pane to be idle 3 consecutive polls, in ms. v2.7 default: 60_000. */
  settleMs: number;
  /** Poll interval for all three loops, in ms. v2.7 default: 2_000. */
  pollMs: number;
}

export const DEFAULT_TIMEOUTS: AutoHandoffTimeouts = {
  readinessMs: 120_000,
  generationMs: 90_000,
  settleMs: 60_000,
  pollMs: 2_000,
};

export type AutoHandoffResult =
  | {
      status: 'completed';
      corr: string;
      handoff_file: string;
      readiness_reason: string;
      session_cleared: true;
    }
  | { status: 'not_found' }
  | { status: 'pane_working'; detail: string }
  | { status: 'readiness_timeout'; detail: string }
  | { status: 'not_ready'; reason: string; detail: string }
  | { status: 'generation_timeout'; partial: true }
  | { status: 'incomplete_file'; file: string; sections_found: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  process.stderr.write(`[auto-handoff] ${msg}\n`);
}

/** UTC stamp stripped of ':' and '.' so it's filename-safe (e.g. 20260419T234300Z). */
function isoForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').replace(/\d{3}Z$/, 'Z');
}

/** Scan the last rendered tail for `Ctx: <pct>%` — returns the most recent match. */
function readCtxPercent(manager: PtyManager, sessionId: SessionId): string {
  const lines = manager.renderedTail(sessionId, 30);
  let last: string | null = null;
  const re = /Ctx:\s*(\d+(?:\.\d+)?)\s*%/;
  for (const line of lines) {
    const m = line.match(re);
    if (m && m[1]) last = m[1];
  }
  return last ?? 'unknown';
}

/** Poll for READY/NOT_READY from the pane's rendered tail. */
async function waitForReadiness(
  manager: PtyManager,
  sessionId: SessionId,
  timeouts: AutoHandoffTimeouts,
): Promise<{ status: 'READY' | 'NOT_READY'; reason: string } | null> {
  const iterations = Math.max(1, Math.floor(timeouts.readinessMs / timeouts.pollMs));
  const re = /●\s*(READY|NOT_READY):\s*(.+?)(?:\n|$)/;
  for (let i = 0; i < iterations; i++) {
    await sleep(timeouts.pollMs);
    try {
      const tail = manager.renderedTail(sessionId, 20).join('\n');
      const m = tail.match(re);
      if (m && m[1] && m[2]) {
        return { status: m[1] as 'READY' | 'NOT_READY', reason: m[2].trim() };
      }
    } catch {
      // Transient terminal state; try again next tick.
    }
  }
  return null;
}

async function waitForFile(
  filePath: string,
  timeouts: AutoHandoffTimeouts,
): Promise<boolean> {
  const iterations = Math.max(1, Math.floor(timeouts.generationMs / timeouts.pollMs));
  for (let i = 0; i < iterations; i++) {
    await sleep(timeouts.pollMs);
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > 200) return true;
    } catch {
      // File not ready yet or racing with the writer; retry.
    }
  }
  return false;
}

async function waitForSettle(
  manager: PtyManager,
  sessionId: SessionId,
  timeouts: AutoHandoffTimeouts,
): Promise<number> {
  const iterations = Math.max(1, Math.floor(timeouts.settleMs / timeouts.pollMs));
  const required = 3;
  let settled = 0;
  for (let i = 0; i < iterations; i++) {
    await sleep(timeouts.pollMs);
    try {
      if (manager.status(sessionId) === 'idle') {
        settled++;
        if (settled >= required) return settled;
      } else {
        settled = 0;
      }
    } catch {
      settled = 0;
    }
  }
  return settled;
}

export async function runAutoHandoff(
  manager: PtyManager,
  _bus: EventBus,
  sessionId: SessionId,
  opts: AutoHandoffOptions = {},
): Promise<AutoHandoffResult> {
  const timeouts: AutoHandoffTimeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) };
  const focus = opts.focus ?? '';
  const force = !!opts.force;

  // Step 1 — pre-flight.
  const record = manager.get(sessionId);
  if (!record) return { status: 'not_found' };
  if (manager.status(sessionId) === 'working' && !force) {
    return {
      status: 'pane_working',
      detail: 'pane is working, retry when idle or pass force:true',
    };
  }

  // Step 2 — readiness check (skip if force).
  let readinessReason = 'forced';
  if (!force) {
    const pct = readCtxPercent(manager, sessionId);
    const checkPrompt =
      `[AUTO-HANDOFF READINESS CHECK] The dashboard is considering a session reset because Ctx is at ${pct}%. ` +
      `Are you at a natural break point where a handoff WOULD NOT lose mid-task context?\n\n` +
      `Reply in exactly this format:\n  READY: <1-line reason>\n  — or —\n  NOT_READY: <what you'd need to finish first>\n\n` +
      `Nothing else.`;
    await manager.writeAndSubmit(sessionId, checkPrompt);
    log(`session-${sessionId} readiness check dispatched (ctx=${pct}%)`);

    const readiness = await waitForReadiness(manager, sessionId, timeouts);
    if (!readiness) {
      log(`session-${sessionId} readiness timed out after ${timeouts.readinessMs}ms`);
      return {
        status: 'readiness_timeout',
        detail: `readiness check timed out after ${Math.floor(timeouts.readinessMs / 1000)}s`,
      };
    }
    log(`session-${sessionId} responded ${readiness.status}: ${readiness.reason.slice(0, 80)}`);
    if (readiness.status === 'NOT_READY') {
      return { status: 'not_ready', reason: readiness.reason, detail: 'pane declined handoff' };
    }
    readinessReason = readiness.reason;
  }

  // Step 3 — dispatch the /handoff skill with a deterministic filename.
  const corrShort = randomBytes(3).toString('hex');
  const corr = `handoff-${corrShort}`;
  const filename = `handoff-${isoForFilename()}-${corrShort}.md`;
  const instruction =
    `Use the /handoff skill to write a comprehensive session handoff to handoffs/${filename}. ` +
    `Corr: ${corr}. Focus: ${focus || 'general checkpoint'}. ` +
    `Include sections: Context, Current State, Open Threads, Next Steps, Constraints & Gotchas, Relevant Files. ` +
    `Do NOT include credentials, API keys, tokens, or private paths. Write the file, then stop.`;
  log(`session-${sessionId} dispatching /handoff skill (corr=${corr})`);
  await manager.writeAndSubmit(sessionId, instruction);

  // Step 4 — poll for file existence.
  const filePath = path.join(record.cwd, 'handoffs', filename);
  const fileFound = await waitForFile(filePath, timeouts);
  if (!fileFound) {
    log(`session-${sessionId} handoff file not written within ${timeouts.generationMs}ms`);
    return { status: 'generation_timeout', partial: true };
  }
  log(`session-${sessionId} handoff file found: ${filename}`);

  // Step 5 — verify sections.
  let sectionCount = 0;
  try {
    const content = fs.readFileSync(filePath, 'utf8').slice(0, 4000);
    sectionCount = ['## Current State', '## Next Steps', '## Open Threads', '## Context'].filter(
      (h) => content.includes(h),
    ).length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`session-${sessionId} failed to read handoff file: ${msg}`);
    return { status: 'incomplete_file', file: `handoffs/${filename}`, sections_found: 0 };
  }
  if (sectionCount < 2) {
    log(`session-${sessionId} handoff file incomplete (${sectionCount}/4 sections)`);
    return {
      status: 'incomplete_file',
      file: `handoffs/${filename}`,
      sections_found: sectionCount,
    };
  }

  // Step 6 — wait for pane to settle (idle 3x consecutive).
  const settled = await waitForSettle(manager, sessionId, timeouts);
  log(`session-${sessionId} settled (idle ${settled}x consecutive), sending /clear`);

  // Step 7 — Ctrl+C → /clear → continuation. `writeAndSubmit` handles the
  // Enter-buffer quirk in Claude's TUI (see pty-manager.writeAndSubmit).
  manager.write(sessionId, '\x03');
  await sleep(500);
  await manager.writeAndSubmit(sessionId, '/clear');
  await sleep(4000);
  const continuation = `Continue your work from the handoff file at handoffs/${filename}. Read it FIRST, then proceed with your next step.`;
  await manager.writeAndSubmit(sessionId, continuation);
  log(`session-${sessionId} continuation injected`);

  return {
    status: 'completed',
    corr,
    handoff_file: `handoffs/${filename}`,
    readiness_reason: readinessReason,
    session_cleared: true,
  };
}
