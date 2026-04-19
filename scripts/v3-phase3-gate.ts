/**
 * Phase 3 gate — exercises the SSE event bus end-to-end.
 *
 * Spins up an in-process backend (no HTTP), attaches all 3 emitter modules,
 * spawns two PTYs, feeds canned content, and asserts each of the 8 SSE event
 * types fires within 1s of the triggering stimulus.
 *
 * Written as a single-process harness so we can snoop bus.subscribe directly
 * rather than reading an actual SSE stream. The SSE wire format is covered
 * separately by a smoke `curl`.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import { EventBus } from '../src/backend/events.js';
import { PtyManager } from '../src/backend/pty-manager.js';
import { attachStatusBarEmitter } from '../src/backend/event-emitters/status-bar.js';
import { attachA2aScanner } from '../src/backend/event-emitters/a2a-scanner.js';
import {
  attachStuckEmitter,
  attachTasksWatcher,
} from '../src/backend/event-emitters/stuck-and-tasks.js';
import { SSE_EVENT_TYPES, type SseEvent, type SseEventType } from '../src/shared/types.js';

interface Expectation {
  type: SseEventType;
  description: string;
  trigger: () => Promise<void> | void;
  timeoutMs: number;
  predicate?: (evt: SseEvent) => boolean;
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(
  bus: EventBus,
  predicate: (evt: SseEvent) => boolean,
  timeoutMs: number,
): Promise<SseEvent | null> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const unsubscribe = bus.subscribe((evt) => {
      if (predicate(evt)) {
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(evt);
      }
    });
    timer = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, timeoutMs);
  });
}

async function main(): Promise<void> {
  const manager = new PtyManager();
  const bus = new EventBus();

  // ─── prep a synthetic active_tasks.md for the tasks watcher ───
  const tasksPath = path.resolve('.phase3-gate-tasks.md');
  await fsPromises.writeFile(tasksPath, '', 'utf-8');

  const disposers: Array<() => void> = [];
  disposers.push(attachStatusBarEmitter(manager, bus));
  disposers.push(attachA2aScanner(manager, bus));
  disposers.push(
    attachStuckEmitter(manager, bus, { thresholdMs: 500, scanIntervalMs: 250 }),
  );
  disposers.push(attachTasksWatcher(bus, tasksPath));

  // ─── spawn two PTYs for pane_idle + A2A + ctx tests ───
  // We use a shell just to keep the PTY process alive. All triggers go
  // through manager._injectForTest() so detection doesn't depend on
  // shell-specific echo/prompt behaviour (cmd.exe's prompt isn't a bare `>`).
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
  const recA = manager.spawn({ cli: shell, args: [], cwd: process.cwd(), tabTitle: 'gate-A' });
  const recB = manager.spawn({ cli: shell, args: [], cwd: process.cwd(), tabTitle: 'gate-B' });

  // Let the shells settle so initial banner doesn't confuse detectors.
  await wait(300);

  const results: Array<{ type: SseEventType; ok: boolean; detail: string }> = [];

  const expectations: Expectation[] = [
    {
      type: 'pane_idle',
      description: 'Spinner glyph then a bare ❯ prompt (pushed past the last-5 window) triggers working→idle',
      timeoutMs: 3_000,
      trigger: async () => {
        // First: inject spinner so status-bar marks pane A as 'working'.
        manager._injectForTest(recA.sessionId, '✽ Crunching... (2s)\r\n');
        await wait(700); // >500ms debounce so the 'working' state gets recorded
        // Then: inject 6+ non-empty filler lines + a trailing bare ❯.
        // nonEmpty filter would eat bare `\r\n` — use visible content so
        // the spinner actually drops out of the last-5 window.
        const idleBlock =
          'idle-filler-1\r\nidle-filler-2\r\nidle-filler-3\r\nidle-filler-4\r\nidle-filler-5\r\nidle-filler-6\r\n❯\r\n';
        manager._injectForTest(recA.sessionId, idleBlock);
      },
      predicate: (e) => e.type === 'pane_idle' && e.sessionId === recA.sessionId,
    },
    {
      type: 'ctx_threshold',
      description: 'Status-bar line `Ctx: 35.0%` crosses the 30 threshold',
      timeoutMs: 2_000,
      trigger: async () => {
        manager._injectForTest(
          recA.sessionId,
          '   Ctx: 35.0%  Context: [x] 350k/1000k (35%)\r\n',
        );
      },
      predicate: (e) =>
        e.type === 'ctx_threshold' && e.sessionId === recA.sessionId && e.crossed === 30,
    },
    {
      type: 'permission_prompt',
      description: 'Prompt text `Do you want to proceed? (y/n)` is detected',
      timeoutMs: 2_000,
      trigger: async () => {
        manager._injectForTest(recA.sessionId, 'Do you want to proceed? (y/n)\r\n');
      },
      predicate: (e) => e.type === 'permission_prompt' && e.sessionId === recA.sessionId,
    },
    {
      type: 'a2a_received',
      description: 'A2A envelope in pane-B output scans out and opens the corr',
      timeoutMs: 2_000,
      trigger: async () => {
        const envelope = `[A2A from pane-${recB.sessionId} to pane-${recA.sessionId} | corr=gate-corr-1 | type=request]\r\n`;
        manager._injectForTest(recB.sessionId, envelope);
      },
      predicate: (e) =>
        e.type === 'a2a_received' && e.corr === 'gate-corr-1' && e.envelopeType === 'request',
    },
    {
      type: 'peer_orphaned',
      description: 'Killing pane-B while corr=gate-corr-1 is open fires peer_orphaned to pane-A',
      timeoutMs: 2_000,
      trigger: async () => {
        manager.kill(recB.sessionId);
      },
      predicate: (e) =>
        e.type === 'peer_orphaned' &&
        e.sessionId === recA.sessionId &&
        e.deadPeer === recB.sessionId,
    },
    {
      type: 'pane_stuck',
      description: 'Working pane with no output for 500ms emits pane_stuck (scan every 250ms)',
      timeoutMs: 3_000,
      trigger: async () => {
        // Mark pane A as 'working' via a spinner line; then do NOT write anything for >500ms.
        // The stuck emitter (threshold=500ms, scan=250ms in this harness) will fire.
        manager._injectForTest(recA.sessionId, '✽ Pondering... (30s)\r\n');
      },
      predicate: (e) => e.type === 'pane_stuck' && e.sessionId === recA.sessionId,
    },
    {
      type: 'task_dispatched',
      description: 'Adding a task with status: in_progress to active_tasks.md fires task_dispatched',
      timeoutMs: 3_000,
      trigger: async () => {
        const content = `## Task: gate-smoke-task\n\`\`\`yaml\nstatus: in_progress\nowner: pane-A\n\`\`\`\n\nBody.\n`;
        await fsPromises.writeFile(tasksPath, content, 'utf-8');
      },
      predicate: (e) => e.type === 'task_dispatched' && e.taskId.includes('gate-smoke-task'),
    },
    {
      type: 'task_completed',
      description: 'Transitioning the task status to completed fires task_completed',
      timeoutMs: 3_000,
      trigger: async () => {
        const content = `## Task: gate-smoke-task\n\`\`\`yaml\nstatus: completed\nowner: pane-A\n\`\`\`\n\nBody.\n`;
        await fsPromises.writeFile(tasksPath, content, 'utf-8');
      },
      predicate: (e) => e.type === 'task_completed' && e.taskId.includes('gate-smoke-task'),
    },
  ];

  for (const exp of expectations) {
    const seenPromise = waitForEvent(bus, exp.predicate ?? ((e) => e.type === exp.type), exp.timeoutMs);
    try {
      await exp.trigger();
    } catch (err) {
      results.push({
        type: exp.type,
        ok: false,
        detail: `trigger threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const evt = await seenPromise;
    if (evt) {
      results.push({ type: exp.type, ok: true, detail: `id=${evt.id}` });
    } else {
      results.push({ type: exp.type, ok: false, detail: `timed out after ${exp.timeoutMs}ms` });
    }
  }

  // Cleanup
  for (const d of disposers) d();
  manager.killAll();
  try {
    await fsPromises.unlink(tasksPath);
  } catch {
    /* ignore */
  }

  // Report
  console.log('');
  console.log('Phase 3 SSE event gate:');
  let passed = 0;
  let failed = 0;
  for (const type of SSE_EVENT_TYPES) {
    const r = results.find((x) => x.type === type);
    if (r) {
      console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${type} — ${r.detail}`);
      if (r.ok) passed += 1;
      else failed += 1;
    } else {
      console.log(`[FAIL] ${type} — no expectation recorded`);
      failed += 1;
    }
  }
  console.log('');
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack : err);
  process.exit(1);
});
