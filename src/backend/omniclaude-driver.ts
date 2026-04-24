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
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

import type { PtyManager, PtyDataEvent } from './pty-manager.js';
import type { EventBus } from './events.js';
import type { PaneQueueStore } from './pane-queue.js';
import type { SessionId, SseEvent } from '../shared/types.js';
import type { DecisionLog } from './orchestrator/decision-log.js';

export interface OmniclaudeDriverOptions {
  enabled: boolean;
  cwd?: string;
  manager: PtyManager;
  bus: EventBus;
  queue: PaneQueueStore;
  /**
   * Optional decision log. When provided, omniclaude's "DECISION:" lines
   * are parsed out of its PTY output stream and appended to the log —
   * satisfies FR-Orch-5 (every decision → vault/_orchestrator/...).
   */
  decisionLog?: DecisionLog;
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

  // Fix #1 — write a per-cwd .mcp.json templated with the LIVE port + token
  // so omniclaude's MCP tools reach THIS backend, not whatever the repo-root
  // .mcp.json was frozen with. Claude Code walks up from cwd to find the
  // nearest .mcp.json; putting one directly in omniclaude's cwd wins.
  try {
    const port = process.env.THEORCHESTRA_PORT ?? '4300';
    const repoRoot = path.resolve(__dirname, '..', '..');
    const mcpBin = path.join(repoRoot, 'bin', 'theorchestra-mcp.js');
    // Always resolve an ABSOLUTE token-file path so the MCP subprocess
    // (whose cwd is not this repo) can find it. Without this, MCP tool calls
    // that hit auth-gated endpoints (spawn_session, kill_session, etc.) fail
    // silently with 401 — which is exactly what happened when "spawn a pane"
    // requests were ignored.
    const tokenFileAbs = path.resolve(
      process.env.THEORCHESTRA_TOKEN_FILE ?? path.join(repoRoot, 'vault', '_auth', 'token.json'),
    );
    // Start with theorchestra (always) then merge in any MCP servers the
    // user has globally configured at ~/.claude/.mcp.json — otherwise the
    // scoped file SHADOWS the global config and omniclaude loses access
    // to memorymaster/serena/etc. (verified 2026-04-22 via sc3 of the
    // briefer-behavior-gate reporting "mm-probed — tool unavailable").
    // Claude Code does not merge across levels; scoped wins outright.
    const mcpServers: Record<string, unknown> = {
      theorchestra: {
        type: 'stdio',
        command: 'node',
        args: [mcpBin.replace(/\\/g, '/')],
        env: {
          THEORCHESTRA_PORT: port,
          THEORCHESTRA_TOKEN_FILE: tokenFileAbs.replace(/\\/g, '/'),
          // Pass-through NO_AUTH so test harnesses work too.
          ...(process.env.THEORCHESTRA_NO_AUTH === '1' ? { THEORCHESTRA_NO_AUTH: '1' } : {}),
        },
      },
    };
    try {
      const homeMcpPath = path.join(os.homedir(), '.claude', '.mcp.json');
      if (fs.existsSync(homeMcpPath)) {
        const raw = fs.readFileSync(homeMcpPath, 'utf-8');
        const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
        if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers) {
          for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
            if (name === 'theorchestra') continue; // don't clobber ours
            mcpServers[name] = cfg;
          }
          const inherited = Object.keys(parsed.mcpServers).filter((k) => k !== 'theorchestra');
          if (inherited.length > 0) {
            console.log(`[omniclaude] inherited MCP servers from ${homeMcpPath}: ${inherited.join(', ')}`);
          }
        }
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[omniclaude] could not merge user-global .mcp.json: ${m}`);
    }
    const mcpJson = { mcpServers };
    fs.writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify(mcpJson, null, 2) + '\n',
      'utf-8',
    );
    console.log(`[omniclaude] wrote .mcp.json at ${cwd} → backend on :${port}`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[omniclaude] failed to write .mcp.json: ${m}`);
  }

  // Spawn omniclaude. We'd like to pass --continue so cross-restart
  // conversation history resumes, BUT `claude --continue` with no prior
  // session exits immediately with code 1 ("No conversation found to
  // continue"). We detect first-run via a sentinel file; subsequent boots
  // use --continue.
  //
  // Windows: `claude` is a .cmd wrapper, so it must be spawned via
  // `cmd.exe /c claude` — direct spawn gets "Cannot create process, error
  // code: 2" from node-pty. POSIX: direct is fine.
  const sentinelPath = path.join(cwd, '.bootstrapped');
  const useContinue = fs.existsSync(sentinelPath);
  const baseArgs: string[] = [];
  if (useContinue) baseArgs.push('--continue');
  // Bypass permissions so omniclaude can spawn peers / read files without
  // interactive prompts. Can be disabled with THEORCHESTRA_OMNICLAUDE_SAFE_MODE=1.
  if (process.env.THEORCHESTRA_OMNICLAUDE_SAFE_MODE !== '1') {
    baseArgs.push('--dangerously-skip-permissions');
  }
  // If the Telegram plugin is installed at user-global or project-scope,
  // auto-subscribe via --channels. Without this flag the plugin's bun server
  // runs but DMs never reach the claude session (silent typing indicator
  // with no response). Docs: https://code.claude.com/docs/en/channels
  const telegramPluginPaths = [
    path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram'),
    path.join(cwd, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram'),
  ];
  const telegramPluginInstalled = telegramPluginPaths.some((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (telegramPluginInstalled && process.env.THEORCHESTRA_OMNICLAUDE_NO_TELEGRAM !== '1') {
    baseArgs.push('--channels', 'plugin:telegram@claude-plugins-official');
  }
  const claudeArgs = baseArgs;
  console.log(
    `[omniclaude] spawning claude ${claudeArgs.join(' ') || '(no args)'}`,
  );
  let rec;
  try {
    const spawnOpts = IS_WINDOWS
      ? {
          cli: 'cmd.exe',
          args: ['/c', 'claude', ...claudeArgs],
          cwd,
          tabTitle: 'omniclaude',
        }
      : {
          cli: 'claude',
          args: claudeArgs,
          cwd,
          tabTitle: 'omniclaude',
        };
    rec = opts.manager.spawn(spawnOpts);
    // Write the sentinel so next boot uses --continue.
    try {
      fs.writeFileSync(sentinelPath, `first boot: ${new Date().toISOString()}\n`, 'utf-8');
    } catch {
      /* non-fatal */
    }
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

  // Fix #2 — pane_idle coalesce. Claude panes emit many idle transitions in
  // quick succession as the status line repaints; without this, omniclaude's
  // queue floods. We keep a per-(type, sid) lastEnqueue map and skip enqueues
  // that happened within the coalesce window. Non-pane_idle events bypass
  // the filter because they're usually meaningful (permission, ctx_threshold,
  // pane_stuck, a2a_received, peer_orphaned).
  const COALESCE_MS = 3000;
  const lastEnqueueForKey = new Map<string, number>();

  // Subscribe to every event type. Self-events (from omniclaude's own pane)
  // are skipped so omniclaude isn't chasing its own shadow.
  const unsubscribe = opts.bus.subscribe((evt: SseEvent) => {
    if ('sessionId' in evt && evt.sessionId === sid) return;

    if (evt.type === 'pane_idle') {
      const key = `pane_idle|${evt.sessionId}`;
      const now = Date.now();
      const last = lastEnqueueForKey.get(key);
      if (last !== undefined && now - last < COALESCE_MS) {
        return; // coalesce: drop this enqueue
      }
      lastEnqueueForKey.set(key, now);
    }

    const body = formatEventBody(evt);
    const prompt = `[EVENT type=${evt.type} id=${evt.id} ts=${evt.ts}]\n${body}\nRespond with MCP tool calls + a DECISION line.`;
    try {
      opts.queue.enqueue(sid, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[omniclaude] enqueue failed: ${msg}`);
    }
  });

  // P8.B — FR-Orch-5 fix: parse "DECISION:" lines out of omniclaude's PTY
  // output and append to the decisions log. Claude TUIs emit lots of ANSI
  // + spinner churn, so we accumulate a running line buffer per chunk and
  // match DECISION lines after ANSI strip.
  const DECISION_RE = /DECISION:\s*([\w-]+)\s*[—\-–]\s*(.{1,400})/g;
  const ANSI_RE = /\x1b(?:\[[?0-9;]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
  const CTRL_RE = /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g;
  let lineBuf = '';
  const seenDecisions = new Set<string>();
  const onData = (evt: PtyDataEvent): void => {
    if (evt.sessionId !== sid) return;
    if (!opts.decisionLog) return;
    // Strip ANSI + control chars, keep newlines.
    const clean = evt.data.replace(ANSI_RE, '').replace(CTRL_RE, ' ');
    lineBuf += clean;
    const nl = lineBuf.lastIndexOf('\n');
    if (nl === -1) return; // wait for a newline
    const complete = lineBuf.slice(0, nl);
    lineBuf = lineBuf.slice(nl + 1);
    for (const match of complete.matchAll(DECISION_RE)) {
      const kind = match[1]!.trim();
      const reason = match[2]!.trim();
      const dedupeKey = `${kind}|${reason.slice(0, 100)}`;
      if (seenDecisions.has(dedupeKey)) continue;
      seenDecisions.add(dedupeKey);
      // Cap the set so it doesn't grow unbounded.
      if (seenDecisions.size > 500) {
        const iter = seenDecisions.values();
        for (let i = 0; i < 200; i++) seenDecisions.delete(iter.next().value!);
      }
      try {
        opts.decisionLog.append({
          ts: new Date().toISOString(),
          sessionId: null,
          trigger: 'omniclaude_decision',
          action: { kind: 'no_op', reason: `omni: ${kind} — ${reason}` },
          classification: { verdict: 'mechanics', reason: 'omniclaude autonomous decision' },
          executed: true,
          notes: `From omniclaude scrollback. Kind: ${kind}.`,
          metadata: { source: 'omniclaude-scrollback', omni_kind: kind, omni_reason: reason },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[omniclaude] decision-log append failed: ${msg}`);
      }
    }
  };
  opts.manager.on('data', onData);

  return {
    sessionId: sid,
    stop(): void {
      unsubscribe();
      opts.manager.off('data', onData);
    },
  };
}
