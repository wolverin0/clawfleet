/**
 * Session manifest — disk persistence so v3.0 can respawn panes after a
 * dashboard-process restart or host reboot.
 *
 * Each manifest is one JSON file at `vault/_sessions/<sessionId>.json`.
 * We write on spawn + on status change + on exit. On startup the dashboard
 * scans the dir and respawns every pane whose PID is dead, using a per-CLI
 * resume-command registry (claude → --continue, codex → documented flag,
 * shells → fresh respawn).
 *
 * ADR-004 is the authoritative design. This module implements §Property 2
 * ("dashboard-process restart") and §Property 3 ("host reboot auto-respawn").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PtyManager } from './pty-manager.js';
import type { SessionId, SessionRecord, PtySpawnOptions } from '../shared/types.js';

export interface SessionManifest {
  sessionId: SessionId;
  pid: number;
  cli: string;
  args: string[];
  cwd: string;
  tabTitle: string;
  persona: string | null;
  permissionMode: string | null;
  spawnedByPaneId: string | null;
  spawnedAt: string;
  lastOutputAt: string | null;
  exitedAt?: string;
  exitCode?: number | null;
}

export interface ResumeStrategy {
  name: string;
  match: (m: SessionManifest) => boolean;
  /**
   * Return the PtySpawnOptions to use for the respawn, or null if this
   * strategy declines (caller will try the next strategy, fall back to
   * fresh-respawn).
   */
  build: (m: SessionManifest) => PtySpawnOptions | null;
}

function normalised(cmd: string): string {
  return cmd.toLowerCase().replace(/\\/g, '/');
}

/**
 * Built-in resume strategies. Order matters — first match wins. "Fresh
 * respawn" is always the last fallback.
 */
export const DEFAULT_RESUME_STRATEGIES: ResumeStrategy[] = [
  // Claude Code — the canonical case. Preserves conversation via --continue.
  {
    name: 'claude --continue',
    match: (m) => {
      const cli = normalised(m.cli);
      if (cli.endsWith('claude') || cli.endsWith('claude.exe')) return true;
      // cmd.exe /c claude shim pattern on Windows.
      if (cli.endsWith('cmd.exe') && m.args.some((a) => normalised(a).endsWith('claude'))) {
        return true;
      }
      return false;
    },
    build: (m) => {
      const isWin = m.cli.toLowerCase().endsWith('cmd.exe');
      if (isWin) {
        // Rebuild as `cmd.exe /c claude [persona-or-continue flags]`.
        const claudeArgs = m.persona
          ? ['--append-system-prompt-file', personaPathFromManifest(m)]
          : ['--continue'];
        if (m.permissionMode) claudeArgs.push('--permission-mode', m.permissionMode);
        return {
          cli: m.cli,
          args: ['/c', 'claude', ...claudeArgs],
          cwd: m.cwd,
          tabTitle: m.tabTitle,
          persona: m.persona,
          permissionMode: m.permissionMode,
          spawnedByPaneId: m.spawnedByPaneId,
        };
      }
      const claudeArgs = m.persona
        ? ['--append-system-prompt-file', personaPathFromManifest(m)]
        : ['--continue'];
      if (m.permissionMode) claudeArgs.push('--permission-mode', m.permissionMode);
      return {
        cli: m.cli,
        args: claudeArgs,
        cwd: m.cwd,
        tabTitle: m.tabTitle,
        persona: m.persona,
        permissionMode: m.permissionMode,
        spawnedByPaneId: m.spawnedByPaneId,
      };
    },
  },
  // Codex CLI — uses --resume if we recorded a session name; else fresh.
  {
    name: 'codex --resume',
    match: (m) => {
      const cli = normalised(m.cli);
      return cli.endsWith('codex') || cli.endsWith('codex.exe');
    },
    build: (m) => {
      // Codex resume flag is --resume if we've stored a session name
      // in persona (we haven't). Fall through to fresh until we wire it.
      return {
        cli: m.cli,
        args: m.args,
        cwd: m.cwd,
        tabTitle: m.tabTitle,
        persona: m.persona,
        permissionMode: m.permissionMode,
        spawnedByPaneId: m.spawnedByPaneId,
      };
    },
  },
  // Generic fallback: respawn with the exact original args (fresh session).
  {
    name: 'fresh respawn',
    match: () => true,
    build: (m) => ({
      cli: m.cli,
      args: m.args,
      cwd: m.cwd,
      tabTitle: m.tabTitle,
      persona: m.persona,
      permissionMode: m.permissionMode,
      spawnedByPaneId: m.spawnedByPaneId,
    }),
  },
];

function personaPathFromManifest(m: SessionManifest): string {
  // At respawn time we don't have the persona resolver context; callers
  // should pre-resolve. If the path was stored verbatim in args (it usually
  // is — spawn_session passes the absolute path to --append-system-prompt-file),
  // pluck it out.
  const idx = m.args.findIndex((a) => a === '--append-system-prompt-file');
  if (idx !== -1 && idx + 1 < m.args.length) return m.args[idx + 1]!;
  return '';
}

export class SessionManifestStore {
  constructor(private readonly dir: string) {}

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  pathFor(sessionId: SessionId): string {
    return path.join(this.dir, `${sessionId}.json`);
  }

  write(manifest: SessionManifest): void {
    this.ensureDir();
    fs.writeFileSync(this.pathFor(manifest.sessionId), JSON.stringify(manifest, null, 2), 'utf-8');
  }

  read(sessionId: SessionId): SessionManifest | null {
    try {
      const text = fs.readFileSync(this.pathFor(sessionId), 'utf-8');
      return JSON.parse(text) as SessionManifest;
    } catch {
      return null;
    }
  }

  delete(sessionId: SessionId): void {
    try {
      fs.unlinkSync(this.pathFor(sessionId));
    } catch {
      /* already gone */
    }
  }

  list(): SessionManifest[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: SessionManifest[] = [];
    for (const entry of fs.readdirSync(this.dir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const text = fs.readFileSync(path.join(this.dir, entry), 'utf-8');
        out.push(JSON.parse(text) as SessionManifest);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }
}

/**
 * Test whether a pid is alive. Uses signal 0 (no-op) — throws if the process
 * does not exist or we don't have permission. On Windows `process.kill` with
 * signal 0 still works as a liveness probe.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no process. EPERM = process exists but we can't signal it
    // (still counts as alive).
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * Wire a manifest store to a PtyManager. Writes on spawn + data (throttled)
 * + exit. Returns a disposer.
 */
export function attachManifestWriter(
  manager: PtyManager,
  store: SessionManifestStore,
): () => void {
  const lastWriteAt = new Map<SessionId, number>();
  const DATA_THROTTLE_MS = 5_000;

  const toManifest = (rec: SessionRecord, opts: Partial<SessionManifest> = {}): SessionManifest => ({
    sessionId: rec.sessionId,
    pid: rec.pid,
    cli: rec.cli,
    args: opts.args ?? [],
    cwd: rec.cwd,
    tabTitle: rec.tabTitle,
    persona: rec.persona ?? null,
    permissionMode: rec.permissionMode ?? null,
    spawnedByPaneId: rec.spawnedByPaneId ?? null,
    spawnedAt: rec.spawnedAt,
    lastOutputAt: opts.lastOutputAt ?? null,
  });

  const onSpawn = (evt: { sessionId: SessionId; record: SessionRecord; spawnArgs?: string[] }): void => {
    const m = toManifest(evt.record, { args: evt.spawnArgs ?? [] });
    store.write(m);
  };

  const onData = (evt: { sessionId: SessionId; data: string }): void => {
    const now = Date.now();
    const last = lastWriteAt.get(evt.sessionId) ?? 0;
    if (now - last < DATA_THROTTLE_MS) return;
    lastWriteAt.set(evt.sessionId, now);
    const rec = manager.get(evt.sessionId);
    if (!rec) return;
    const existing = store.read(evt.sessionId);
    if (!existing) return;
    existing.lastOutputAt = new Date(now).toISOString();
    existing.pid = rec.pid;
    store.write(existing);
  };

  const onExit = (evt: { sessionId: SessionId; code: number | null }): void => {
    const existing = store.read(evt.sessionId);
    if (!existing) return;
    existing.exitedAt = new Date().toISOString();
    existing.exitCode = evt.code;
    store.write(existing);
    lastWriteAt.delete(evt.sessionId);
  };

  manager.on('spawn', onSpawn);
  manager.on('data', onData);
  manager.on('exit', onExit);

  return () => {
    manager.off('spawn', onSpawn);
    manager.off('data', onData);
    manager.off('exit', onExit);
  };
}

export interface RespawnResult {
  oldSessionId: SessionId;
  newSessionId: SessionId;
  strategy: string;
  pid: number;
  cwd: string;
  tabTitle: string;
}

/**
 * Respawn every manifest whose pid is not alive. Returns one RespawnResult
 * per recovered pane. Dead pids get deleted from the manifest dir after
 * successful respawn (so the next startup doesn't respawn again).
 */
export function respawnDeadSessions(
  manager: PtyManager,
  store: SessionManifestStore,
  strategies: ResumeStrategy[] = DEFAULT_RESUME_STRATEGIES,
  options: { bannerPrefix?: string } = {},
): RespawnResult[] {
  const banner = options.bannerPrefix ?? '[theorchestra] pane resumed at';
  const results: RespawnResult[] = [];
  for (const m of store.list()) {
    if (m.exitedAt) {
      // Already exited last session — drop the manifest, don't respawn.
      store.delete(m.sessionId);
      continue;
    }
    if (isPidAlive(m.pid)) continue; // skip live panes (shouldn't happen on cold start)

    const strategy = strategies.find((s) => s.match(m));
    if (!strategy) continue;
    const opts = strategy.build(m);
    if (!opts) continue;

    try {
      const newRec = manager.spawn(opts);
      const bannerLine = `${banner} ${new Date().toISOString()} (strategy=${strategy.name})\r\n`;
      try {
        manager.injectBanner(newRec.sessionId, bannerLine);
      } catch {
        /* ring-buffer banner is best-effort */
      }
      store.delete(m.sessionId);
      // Persist the new session's manifest.
      store.write({
        sessionId: newRec.sessionId,
        pid: newRec.pid,
        cli: newRec.cli,
        args: opts.args ?? [],
        cwd: newRec.cwd,
        tabTitle: newRec.tabTitle,
        persona: newRec.persona ?? null,
        permissionMode: newRec.permissionMode ?? null,
        spawnedByPaneId: newRec.spawnedByPaneId ?? null,
        spawnedAt: newRec.spawnedAt,
        lastOutputAt: null,
      });
      results.push({
        oldSessionId: m.sessionId,
        newSessionId: newRec.sessionId,
        strategy: strategy.name,
        pid: newRec.pid,
        cwd: newRec.cwd,
        tabTitle: newRec.tabTitle,
      });
    } catch (err) {
      process.stderr.write(
        `[session-manifest] respawn failed for ${m.sessionId} (${strategy.name}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return results;
}
