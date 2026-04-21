/**
 * P7.A/B — omniclaude pane lifecycle + event-to-prompt driver.
 *
 * Spawns ONE persistent Claude Code session at `vault/_omniclaude/` (if
 * enabled via THEORCHESTRA_OMNICLAUDE=1) and subscribes to the event bus.
 * Every SseEvent becomes a formatted prompt that gets queued for the
 * omniclaude pane; the queue drains one entry per `pane_idle` from
 * omniclaude itself, so events are processed serially.
 *
 * On the same sid receiving two events in a row while omniclaude is
 * mid-turn, both are queued in order. The queue is per-pane in
 * PaneQueueStore — omniclaude's pane IS a pane — so no new data
 * structure is needed.
 *
 * Omniclaude is filtered out of the default GET /api/sessions list so
 * users don't see it unless they pass ?include_omni=1. That filter is
 * applied in ws-server.ts using getOmniclaudeSid().
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import type { PtyManager } from './pty-manager.js';
import type { EventBus } from './events.js';
import type { PaneQueueStore } from './pane-queue.js';
import type { SessionId, SseEvent } from '../shared/types.js';

export interface OmniclaudeDriverOptions {
  enabled: boolean;
  cwd?: string;
  manager: PtyManager;
  bus: EventBus;
  queue: PaneQueueStore;
}

export interface OmniclaudeDriver {
  /** The omniclaude pane's sessionId, or null if not spawned. */
  readonly sessionId: SessionId | null;
  /** Shut down the subscriber (does not kill the pane). */
  stop(): void;
}

const NOT_RUNNING: OmniclaudeDriver = {
  sessionId: null,
  stop() {
    /* no-op */
  },
};

const IS_WINDOWS = process.platform === 'win32';

function isClaudeOnPath(): boolean {
  const which = IS_WINDOWS ? 'where' : 'which';
  try {
    const r = spawnSync(which, ['claude'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function defaultCwd(): string {
  if (process.env.THEORCHESTRA_OMNICLAUDE_CWD) {
    return path.resolve(process.env.THEORCHESTRA_OMNICLAUDE_CWD);
  }
  return path.resolve(process.cwd(), 'vault', '_omniclaude');
}

function shortSid(sid: string | null | undefined): string {
  if (!sid) return 'none';
  return sid.slice(0, 8);
}

/**
 * Summarise an SseEvent into the body of a prompt omniclaude receives.
 * Kept compact — the full event payload is still available to omniclaude
 * via get_recent_decisions / read_output if it needs more.
 */
function formatEventBody(evt: SseEvent): string {
  switch (evt.type) {
    case 'permission_prompt':
      return `Pane ${shortSid(evt.sessionId)} is asking: "${evt.promptText.slice(0, 300)}"`;
    case 'pane_idle':
      return `Pane ${shortSid(evt.sessionId)} went idle. Scrollback-check to decide if it's done, waiting, or stuck.`;
    case 'ctx_threshold':
      return `Pane ${shortSid(evt.sessionId)} ctx=${evt.percent}% (crossed ${evt.crossed}).`;
    case 'pane_stuck':
      return `Pane ${shortSid(evt.sessionId)} has been "working" for ${Math.round(evt.idleMs / 1000)}s with no output change.`;
    case 'a2a_received':
      return `A2A envelope: from ${evt.from} to ${evt.to}, corr=${evt.corr}, type=${evt.envelopeType}.`;
    case 'peer_orphaned':
      return `Peer ${shortSid(evt.deadPeer)} died with open corr=${evt.corr} (originator: ${shortSid(evt.sessionId)}).`;
    case 'task_dispatched':
      return `Task dispatched: ${evt.taskId} (owner=${evt.owner ?? 'unassigned'}, path=${evt.path}).`;
    case 'task_completed':
      return `Task completed: ${evt.taskId} (owner=${evt.owner ?? 'unassigned'}, path=${evt.path}).`;
  }
}

export function startOmniclaudeDriver(opts: OmniclaudeDriverOptions): OmniclaudeDriver {
  if (!opts.enabled) {
    console.log('[omniclaude] disabled (set THEORCHESTRA_OMNICLAUDE=1 to enable)');
    return NOT_RUNNING;
  }
  if (!isClaudeOnPath()) {
    console.log('[omniclaude] `claude` not on PATH — driver disabled');
    return NOT_RUNNING;
  }

  const cwd = opts.cwd ?? defaultCwd();
  fs.mkdirSync(cwd, { recursive: true });

  // Spawn omniclaude with --continue so it picks up prior session history
  // across backend restarts. First run starts a fresh session.
  // Windows: `claude` is a .cmd wrapper, so it must be spawned via
  // `cmd.exe /c claude --continue` — direct spawn gets "Cannot create
  // process, error code: 2" from node-pty. POSIX: direct is fine.
  let rec;
  try {
    const spawnOpts = IS_WINDOWS
      ? {
          cli: 'cmd.exe',
          args: ['/c', 'claude', '--continue'],
          cwd,
          tabTitle: 'omniclaude',
        }
      : {
          cli: 'claude',
          args: ['--continue'],
          cwd,
          tabTitle: 'omniclaude',
        };
    rec = opts.manager.spawn(spawnOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[omniclaude] spawn failed: ${msg}`);
    return NOT_RUNNING;
  }

  const sid = rec.sessionId;
  console.log(`[omniclaude] spawned pane ${shortSid(sid)} (pid=${rec.pid}) at ${cwd}`);

  // Boot prompt — formatted as if it were an event so omniclaude's CLAUDE.md
  // "boot sequence" instructions fire. Sent after a short delay so Claude
  // has time to start up and read CLAUDE.md.
  setTimeout(() => {
    try {
      opts.manager.writeAndSubmit(
        sid,
        '[BOOT] theorchestra backend started. Read your CLAUDE.md, call list_projects + discover_sessions, then wait for [EVENT] prompts.',
        300,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[omniclaude] boot-prompt write failed: ${msg}`);
    }
  }, 4000);

  // Subscribe to every event type. Self-events (from omniclaude's own pane)
  // are skipped so omniclaude isn't chasing its own shadow.
  const unsubscribe = opts.bus.subscribe((evt: SseEvent) => {
    if ('sessionId' in evt && evt.sessionId === sid) return;
    const body = formatEventBody(evt);
    const prompt = `[EVENT type=${evt.type} id=${evt.id} ts=${evt.ts}]\n${body}\nRespond with MCP tool calls + a DECISION line.`;
    try {
      opts.queue.enqueue(sid, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[omniclaude] enqueue failed: ${msg}`);
    }
  });

  return {
    sessionId: sid,
    stop(): void {
      unsubscribe();
    },
  };
}
