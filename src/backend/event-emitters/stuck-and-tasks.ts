/**
 * stuck-and-tasks emitter — two independent attachers in one module:
 *
 *   1. `attachStuckEmitter(manager, bus, thresholdMs?)` — periodically scans
 *      the PtyManager and emits `pane_stuck` for sessions that have been in
 *      `status === 'working'` with no new output for longer than `thresholdMs`.
 *      Re-arm rule: once a session fires a `pane_stuck` event, it cannot fire
 *      again until the session transitions out of `working` (to `idle` or
 *      `exited`) and back into `working` — preventing a 30s re-emission loop
 *      while the user is staring at the same stuck pane.
 *
 *   2. `attachTasksWatcher(bus, tasksFilePath)` — watches a v2.7-style
 *      `active_tasks.md` file. Each `## Task: <title>` section with a fenced
 *      YAML block describes one task record. Status transitions drive
 *      `task_dispatched` (to `in_progress`) and `task_completed` (to
 *      `completed`). We do a cheap key:value line parse — no js-yaml dep.
 *
 * Both attachers return a disposer that cleans up timers, watchers, and
 * listener maps. Neither throws on malformed input — they log a stderr
 * warning and no-op until the next tick.
 */

import { readFileSync, watch, existsSync, type FSWatcher } from 'node:fs';

import type { PtyManager } from '../pty-manager.js';
import type { EventBus } from '../events.js';
import { STUCK_THRESHOLD_MS, type SessionId } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// attachStuckEmitter
// ---------------------------------------------------------------------------

/** How often the stuck scanner runs. */
const STUCK_SCAN_INTERVAL_MS = 30_000;

/**
 * Spinner / working-verb patterns mirroring the ones in `status-bar.ts`.
 * We read the rendered buffer directly rather than trusting `PtyManager.status()`
 * because that heuristic flips to 'idle' after WORKING_THRESHOLD_MS of silence —
 * which is exactly the condition under which pane_stuck should fire. The
 * visible UI still shows a spinner, so that's what we key off.
 */
const STUCK_SPINNER_RE = /[✽✻⏺✳⏵◆◇◉]/;
const STUCK_VERB_RE = /\b(?:Inferring|Pondering|Crunching|Sauté|Brewed|Baked|Rendering|Compacting|Analyzing|Thinking|Contemplating|Processing)(?:ing|ed)?…?\b/i;

function isVisuallyWorking(tailLines: string[]): boolean {
  const lastFive = tailLines.slice(-5);
  return lastFive.some((l) => STUCK_SPINNER_RE.test(l) || STUCK_VERB_RE.test(l));
}

interface StuckEntry {
  /** True once we've emitted `pane_stuck` for the current working-streak. */
  emitted: boolean;
  /** Whether the PREVIOUS scan observed a visually-working state. */
  lastVisuallyWorking: boolean;
  /** When we first observed this working streak (ms epoch). */
  streakStartedAt: number | null;
}

export interface StuckEmitterOptions {
  thresholdMs?: number;
  /** How often to scan. Defaults to STUCK_SCAN_INTERVAL_MS (30s). Gate
   * harnesses pass a shorter value for fast determinism. */
  scanIntervalMs?: number;
}

export function attachStuckEmitter(
  manager: PtyManager,
  bus: EventBus,
  thresholdMsOrOpts: number | StuckEmitterOptions = STUCK_THRESHOLD_MS,
): () => void {
  const opts: StuckEmitterOptions =
    typeof thresholdMsOrOpts === 'number'
      ? { thresholdMs: thresholdMsOrOpts }
      : thresholdMsOrOpts;
  const thresholdMs = opts.thresholdMs ?? STUCK_THRESHOLD_MS;
  const scanIntervalMs = opts.scanIntervalMs ?? STUCK_SCAN_INTERVAL_MS;
  const entries = new Map<SessionId, StuckEntry>();

  const scan = (): void => {
    const now = Date.now();
    const seen = new Set<SessionId>();

    for (const record of manager.list()) {
      const id = record.sessionId;
      seen.add(id);

      const detail = manager.statusDetail(id);
      if (!detail) continue;
      if (detail.status === 'exited') {
        entries.delete(id);
        continue;
      }

      const tail = manager.renderedTail(id, 30);
      const working = isVisuallyWorking(tail);

      let entry = entries.get(id);
      if (!entry) {
        entry = { emitted: false, lastVisuallyWorking: false, streakStartedAt: null };
        entries.set(id, entry);
      }

      // Re-arm: any transition OUT of 'working' (visual) resets emission + streak.
      if (entry.lastVisuallyWorking && !working) {
        entry.emitted = false;
        entry.streakStartedAt = null;
      }
      // New working streak starts.
      if (!entry.lastVisuallyWorking && working) {
        entry.streakStartedAt = now;
      }
      entry.lastVisuallyWorking = working;

      if (!working) continue;
      if (entry.emitted) continue;
      if (entry.streakStartedAt === null) continue;

      const idleMs = now - entry.streakStartedAt;
      if (idleMs < thresholdMs) continue;

      bus.publish({ type: 'pane_stuck', sessionId: id, idleMs });
      entry.emitted = true;
    }

    // Drop state for sessions that no longer exist in the manager.
    for (const id of Array.from(entries.keys())) {
      if (!seen.has(id)) entries.delete(id);
    }
  };

  const interval = setInterval(() => {
    try {
      scan();
    } catch (err) {
      process.stderr.write(
        `[stuck-emitter] scan failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }, scanIntervalMs);
  // Don't keep the process alive on this interval alone.
  if (typeof interval.unref === 'function') interval.unref();

  return () => {
    clearInterval(interval);
    entries.clear();
  };
}

// ---------------------------------------------------------------------------
// attachTasksWatcher
// ---------------------------------------------------------------------------

/** Debounce window after a filesystem event before we re-read. */
const TASKS_WATCH_DEBOUNCE_MS = 300;

type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'stuck'
  | 'cancelled'
  | 'unknown';

interface TaskRec {
  title: string;
  status: TaskStatus;
  owner: string | null;
  corr: string | null;
  dispatched_at: string | null;
  completed_at: string | null;
  path: string;
}

/**
 * Match each `## <title>` section followed by a fenced code block. The fence
 * may be ```yaml or a bare ```. Captures:
 *   [1] = section title (trimmed by the split)
 *   [2] = fenced body
 */
const SECTION_RE = /^##\s+(.+?)\s*\n```(?:yaml)?\s*\n([\s\S]*?)\n```/gm;

/** Accepted keys per the v2.7 `active_tasks.md` contract. */
const TASK_KEYS: readonly (keyof Omit<TaskRec, 'title' | 'path'>)[] = [
  'status',
  'owner',
  'corr',
  'dispatched_at',
  'completed_at',
];

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function coerceStatus(raw: string | null): TaskStatus {
  if (raw === null) return 'unknown';
  const v = raw.toLowerCase();
  if (v === 'pending' || v === 'in_progress' || v === 'completed' || v === 'stuck' || v === 'cancelled') {
    return v;
  }
  return 'unknown';
}

/**
 * Cheap key:value line parser for a single YAML-ish fenced block.
 *
 * Edge cases (by design, not bugs):
 *   - Empty block          → every field null, status 'unknown' (caller skips).
 *   - Missing keys         → remain null.
 *   - Unknown keys         → ignored.
 *   - Nested structures    → ignored (we don't recurse into `follow_ups: [...]`).
 *   - Quoted values        → single- and double-quotes stripped.
 *   - Malformed lines      → silently skipped so one bad row doesn't taint the rest.
 */
function parseTaskBlock(title: string, body: string, path: string): TaskRec | null {
  const rec: TaskRec = {
    title,
    status: 'unknown',
    owner: null,
    corr: null,
    dispatched_at: null,
    completed_at: null,
    path,
  };

  const lines = body.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue; // yaml comment
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1);

    if (!(TASK_KEYS as readonly string[]).includes(key)) continue;

    const cleaned = stripQuotes(value);
    if (cleaned.length === 0) continue;
    // Arrays / objects we don't care about:
    if (cleaned.startsWith('[') || cleaned.startsWith('{')) continue;

    if (key === 'status') {
      rec.status = coerceStatus(cleaned);
    } else if (key === 'owner') {
      rec.owner = cleaned;
    } else if (key === 'corr') {
      rec.corr = cleaned;
    } else if (key === 'dispatched_at') {
      rec.dispatched_at = cleaned;
    } else if (key === 'completed_at') {
      rec.completed_at = cleaned;
    }
  }

  if (rec.status === 'unknown') return null;
  return rec;
}

export type { TaskRec, TaskStatus };

/** Public: read + parse a v2.7-shaped active_tasks.md. */
export function readTasks(path: string): TaskRec[] {
  return Array.from(parseTasksFile(path).values());
}

function parseTasksFile(path: string): Map<string, TaskRec> {
  const out = new Map<string, TaskRec>();
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return out;
  }

  // Re-create the regex per call — /g stateful-ness does not compose across invocations.
  const re = new RegExp(SECTION_RE.source, SECTION_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const title = match[1]?.trim();
    const body = match[2] ?? '';
    if (!title) continue;
    const rec = parseTaskBlock(title, body, path);
    if (!rec) continue;
    // Later duplicates win — a sane default that matches v2.7 behaviour.
    out.set(title, rec);
  }
  return out;
}

export function attachTasksWatcher(bus: EventBus, tasksFilePath: string): () => void {
  let state: Map<string, TaskRec> = existsSync(tasksFilePath)
    ? parseTasksFile(tasksFilePath)
    : new Map();

  let debounceTimer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;

  const reconcile = (): void => {
    if (!existsSync(tasksFilePath)) return;

    let next: Map<string, TaskRec>;
    try {
      next = parseTasksFile(tasksFilePath);
    } catch (err) {
      process.stderr.write(
        `[tasks-watcher] parse failed for ${tasksFilePath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

    for (const [taskId, fresh] of next) {
      const prev = state.get(taskId);
      if (!prev) {
        if (fresh.status === 'in_progress') {
          bus.publish({
            type: 'task_dispatched',
            taskId,
            owner: fresh.owner,
            path: tasksFilePath,
          });
        } else if (fresh.status === 'completed') {
          // Task appeared already completed — emit once so downstream sees it.
          bus.publish({
            type: 'task_completed',
            taskId,
            owner: fresh.owner,
            path: tasksFilePath,
          });
        }
        continue;
      }

      if (prev.status !== 'in_progress' && fresh.status === 'in_progress') {
        bus.publish({
          type: 'task_dispatched',
          taskId,
          owner: fresh.owner,
          path: tasksFilePath,
        });
      }
      if (prev.status !== 'completed' && fresh.status === 'completed') {
        bus.publish({
          type: 'task_completed',
          taskId,
          owner: fresh.owner,
          path: tasksFilePath,
        });
      }
    }

    state = next;
  };

  const scheduleReconcile = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        reconcile();
      } catch (err) {
        process.stderr.write(
          `[tasks-watcher] reconcile failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }, TASKS_WATCH_DEBOUNCE_MS);
  };

  try {
    watcher = watch(tasksFilePath, { persistent: false }, () => {
      scheduleReconcile();
    });
    watcher.on('error', (err) => {
      process.stderr.write(
        `[tasks-watcher] watcher error for ${tasksFilePath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  } catch (err) {
    // fs.watch throws ENOENT if the file is missing. We no-op; a future
    // attach can pick it up once the file lands.
    process.stderr.write(
      `[tasks-watcher] cannot watch ${tasksFilePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    watcher = null;
  }

  return () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (watcher !== null) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
      watcher = null;
    }
    state.clear();
  };
}
