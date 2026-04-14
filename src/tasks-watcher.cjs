#!/usr/bin/env node
/**
 * tasks-watcher.cjs — watches active_tasks.md and emits events when task
 * state deserves attention. Designed to be run as a Monitor tool child
 * process by OmniClaude.
 *
 * Events emitted to stdout (one JSON object per line):
 *   - watcher_started
 *   - tasks_file_updated        → mtime change
 *   - task_added                → new T-NNN heading appeared
 *   - task_status_changed       → existing task's status field changed
 *   - task_stuck                → status=in_progress AND no progress update
 *                                  older than stuck_threshold_min (default 15)
 *   - followups_pending         → task closed but has follow_ups that are
 *                                  still pending with no dispatched_at
 *   - parse_error               → file parse failed
 *   - heartbeat                 → every 5 min
 *
 * Stderr is for debug logs.
 *
 * Env vars:
 *   - ACTIVE_TASKS_FILE: path to active_tasks.md (default: omniclaude/active_tasks.md)
 *   - TASKS_POLL_MS: stuck-check interval (default 60000)
 *   - TASKS_STUCK_DEFAULT_MIN: default stuck threshold (default 15)
 */

const fs = require('fs');
const path = require('path');
const { parseTasksFile } = require('./task-parser.cjs');
const wez = require('./wezterm.cjs');

// --- Config ---
const ACTIVE_TASKS_FILE = process.env.ACTIVE_TASKS_FILE
  || path.join('G:/_OneDrive/OneDrive/Desktop/Py Apps/omniclaude', 'active_tasks.md');
const POLL_INTERVAL_MS = parseInt(process.env.TASKS_POLL_MS || '60000', 10);
const HEARTBEAT_MS = 300000;
const STUCK_DEFAULT_MIN = parseInt(process.env.TASKS_STUCK_DEFAULT_MIN || '15', 10);
const FOLLOWUPS_GRACE_MS = 300000; // 5 min grace after parent closes before yelling

// --- Emit helpers ---
const emit = (event) => {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch { /* stdout closed */ }
};
const log = (msg) => {
  process.stderr.write(`[tasks-watcher] ${new Date().toISOString()} ${msg}\n`);
};

// --- State ---
let previousTasks = new Map();        // id -> task snapshot
const stuckEmitted = new Map();        // id -> ts when we last emitted task_stuck
const followupsEmitted = new Map();    // parentId -> ts when emitted followups_pending
const paneActivity = new Map();        // pane_id -> { hash, changedAt } — tracks content change per pane
const STUCK_RENOTIFY_MS = 10 * 60 * 1000;       // re-yell every 10 min if still stuck
const FOLLOWUPS_RENOTIFY_MS = 15 * 60 * 1000;   // re-yell every 15 min if still pending

function parseSafely() {
  const result = parseTasksFile(ACTIVE_TASKS_FILE);
  for (const err of result.errors) {
    emit({ source: 'tasks-watcher', event: 'parse_error', error: err, severity: 'P1' });
  }
  return result.tasks;
}

function diffTasks(prev, cur) {
  const added = [];
  const changed = [];
  for (const [id, task] of cur) {
    const before = prev.get(id);
    if (!before) {
      added.push(task);
    } else if (before.status !== task.status) {
      changed.push({ task, from: before.status, to: task.status });
    }
  }
  return { added, changed };
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/**
 * Stuck detection: "pane owner had no output change for > threshold".
 * Matches omni-watcher's stuck semantics (activity-based, not dispatch-age).
 * If owner is not a pane (user/omniclaude/etc) or pane unreadable, fall back
 * to dispatch-age heuristic with 3x threshold so we don't noise-alert.
 */
function checkStuckTasks(tasks) {
  const now = Date.now();
  for (const task of tasks.values()) {
    if (task.status !== 'in_progress') continue;
    const thresholdMin = parseInt(task.stuck_threshold_min, 10) || STUCK_DEFAULT_MIN;
    const thresholdMs = thresholdMin * 60 * 1000;

    // Extract pane id from owner like "pane-35"
    const paneMatch = String(task.owner || '').match(/^pane-(\d+)$/);
    let age = null;
    let ageReason = null;

    if (paneMatch) {
      const paneId = parseInt(paneMatch[1], 10);
      let content = '';
      try {
        content = wez.getFullText(paneId) || '';
      } catch {
        // Pane unreadable — might be dead. Fall through to dispatch-age fallback.
      }
      if (content) {
        // Fingerprint from a wide tail window that excludes static input-prompt lines.
        // Claude Code / Codex TUIs render a static input prompt placeholder at the very
        // bottom (e.g. "› Summarize recent commits", "gpt-5.4 high · cwd") that does
        // NOT change while the session is working. Hashing only the last 5 lines would
        // miss activity happening ABOVE the footer. Use last 20 non-empty lines so
        // spinner-line changes and tool-call output bubble into the hash.
        const lines = content.split('\n').filter(l => l.trim());
        const tail = lines.slice(-20).join('\n');
        const hash = simpleHash(tail);
        const prev = paneActivity.get(paneId);
        if (!prev || prev.hash !== hash) {
          paneActivity.set(paneId, { hash, changedAt: now });
          continue; // Activity detected → not stuck
        }
        age = now - prev.changedAt;
        ageReason = 'no_output_change';

        // Waiting-for-input detection: if pane is idle with ❯ prompt and the
        // last spinner line says "for Xs" (past tense / done), the pane is NOT
        // stuck — it's waiting for the user to make a decision. Silence is
        // by design, not a problem.
        const last30 = lines.slice(-30);
        const hasBarePrompt = last30.some(l => /^\s*[❯>]\s*$/.test(l));
        const hasDoneSpinner = last30.some(l => /^\s*[✢✻✶✽✣⏳✦✧]\s.*\bfor\s+\d+(m|s)/.test(l));
        if (hasBarePrompt && hasDoneSpinner) {
          ageReason = 'waiting_user_input';
          // Don't emit stuck — this is expected idle state
          continue;
        }
      }
    }

    if (age === null) {
      // Fallback: dispatch-age heuristic with 3x threshold (conservative)
      const refStr = task.dispatched_at || task.created_at;
      if (!refStr) continue;
      const refTs = Date.parse(refStr);
      if (isNaN(refTs)) continue;
      age = now - refTs;
      ageReason = 'dispatch_age_fallback';
      if (age < thresholdMs * 3) continue;
    } else if (age < thresholdMs) {
      continue;
    }

    const lastEmit = stuckEmitted.get(task.id) || 0;
    if (now - lastEmit < STUCK_RENOTIFY_MS) continue;
    stuckEmitted.set(task.id, now);

    emit({
      source: 'tasks-watcher',
      event: 'task_stuck',
      task_id: task.id,
      title: task.title,
      owner: task.owner,
      age_min: Math.round(age / 60000),
      threshold_min: thresholdMin,
      reason: ageReason,
      severity: 'P2',
    });
  }
}

function checkFollowups(tasks) {
  const now = Date.now();
  for (const task of tasks.values()) {
    if (task.status !== 'completed') continue;
    if (!task.completed_at) continue;
    const completedTs = Date.parse(task.completed_at);
    if (isNaN(completedTs)) continue;
    if (now - completedTs < FOLLOWUPS_GRACE_MS) continue;

    const followUps = Array.isArray(task.follow_ups) ? task.follow_ups : [];
    if (followUps.length === 0) continue;

    // Extract just the T-NNN portion from each entry (may be "T-043: Description")
    const pendingIds = [];
    for (const entry of followUps) {
      const idMatch = String(entry).match(/^(T-\d+)/);
      if (!idMatch) continue;
      const id = idMatch[1];
      const t = tasks.get(id);
      if (!t) {
        pendingIds.push({ id, reason: 'not_in_file', hint: entry });
      } else if (t.status === 'pending' && !t.dispatched_at) {
        pendingIds.push({ id, reason: 'pending_not_dispatched', title: t.title });
      }
    }
    if (pendingIds.length === 0) continue;

    const lastEmit = followupsEmitted.get(task.id) || 0;
    if (now - lastEmit < FOLLOWUPS_RENOTIFY_MS) continue;
    followupsEmitted.set(task.id, now);

    emit({
      source: 'tasks-watcher',
      event: 'followups_pending',
      parent: task.id,
      parent_title: task.title,
      pending: pendingIds,
      severity: 'P1',
    });
  }
}

function clearClosedState(tasks) {
  // If a task left in_progress, clear its stuck emission tracker
  for (const id of stuckEmitted.keys()) {
    const t = tasks.get(id);
    if (!t || t.status !== 'in_progress') stuckEmitted.delete(id);
  }
  // If a task's follow_ups were addressed, clear its emission tracker
  for (const id of followupsEmitted.keys()) {
    const t = tasks.get(id);
    if (!t) { followupsEmitted.delete(id); continue; }
    const followUps = Array.isArray(t.follow_ups) ? t.follow_ups : [];
    const stillPending = followUps.some(entry => {
      const m = String(entry).match(/^(T-\d+)/);
      if (!m) return false;
      const child = tasks.get(m[1]);
      return child && child.status === 'pending' && !child.dispatched_at;
    });
    if (!stillPending) followupsEmitted.delete(id);
  }
}

// --- Main loop ---
function tick() {
  const current = parseSafely();
  const { added, changed } = diffTasks(previousTasks, current);

  for (const task of added) {
    emit({
      source: 'tasks-watcher',
      event: 'task_added',
      task_id: task.id,
      title: task.title,
      status: task.status,
      owner: task.owner,
    });
  }
  for (const { task, from, to } of changed) {
    emit({
      source: 'tasks-watcher',
      event: 'task_status_changed',
      task_id: task.id,
      title: task.title,
      from,
      to,
      owner: task.owner,
    });
  }

  checkStuckTasks(current);
  checkFollowups(current);
  clearClosedState(current);

  previousTasks = current;
}

// --- Boot ---
if (!fs.existsSync(ACTIVE_TASKS_FILE)) {
  log(`WARNING: ${ACTIVE_TASKS_FILE} does not exist; creating empty`);
  try {
    fs.writeFileSync(ACTIVE_TASKS_FILE, '# Active Tasks\n\n## T-000 · Seed\n```yaml\nstatus: completed\nowner: omniclaude\ncreated_at: ' + new Date().toISOString() + '\n```\n');
  } catch (err) {
    log(`Cannot create seed: ${err.message}`);
    process.exit(1);
  }
}

emit({
  source: 'tasks-watcher',
  event: 'watcher_started',
  file: ACTIVE_TASKS_FILE,
  poll_interval_ms: POLL_INTERVAL_MS,
  stuck_default_min: STUCK_DEFAULT_MIN,
});
log(`Watching ${ACTIVE_TASKS_FILE}`);

// Initial parse
previousTasks = parseSafely();
emit({
  source: 'tasks-watcher',
  event: 'initial_state',
  task_count: previousTasks.size,
  in_progress: [...previousTasks.values()].filter(t => t.status === 'in_progress').map(t => t.id),
});

// fs.watch for immediate change detection
let debounceTimer = null;
fs.watch(ACTIVE_TASKS_FILE, { persistent: true }, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    emit({ source: 'tasks-watcher', event: 'tasks_file_updated' });
    tick();
  }, 500); // debounce rapid writes
});

// Periodic tick for stuck / followups detection (doesn't need file change)
setInterval(tick, POLL_INTERVAL_MS);

// Heartbeat
setInterval(() => {
  emit({
    source: 'tasks-watcher',
    event: 'heartbeat',
    task_count: previousTasks.size,
    in_progress: [...previousTasks.values()].filter(t => t.status === 'in_progress').length,
  });
}, HEARTBEAT_MS);

// Graceful shutdown
process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT'); process.exit(0); });
