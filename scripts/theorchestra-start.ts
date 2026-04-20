/**
 * theorchestra v3.0 Phase 1 entrypoint.
 *
 * Boots one PtyManager, spawns one default session (preferring `claude` on
 * PATH, falling back to the platform shell), and starts the HTTP + WS server
 * on DEFAULT_DASHBOARD_PORT.
 */

import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PtyManager } from '../src/backend/pty-manager.js';
import { startServer } from '../src/backend/ws-server.js';
import { attachStatusBarEmitter } from '../src/backend/event-emitters/status-bar.js';
import { attachA2aScanner } from '../src/backend/event-emitters/a2a-scanner.js';
import {
  attachStuckEmitter,
  attachTasksWatcher,
} from '../src/backend/event-emitters/stuck-and-tasks.js';
import {
  SessionManifestStore,
  attachManifestWriter,
  respawnDeadSessions,
} from '../src/backend/session-manifest.js';
import {
  DEFAULT_DASHBOARD_PORT,
  type PtySpawnOptions,
  type SessionRecord,
} from '../src/shared/types.js';

const IS_WINDOWS = process.platform === 'win32';

function defaultCwd(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
}

/** Probe PATH for an executable. Returns true if a working lookup succeeds. */
function isOnPath(cmd: string): boolean {
  const which = IS_WINDOWS ? 'where' : 'which';
  try {
    const r = spawnSync(which, [cmd], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

interface SpawnAttempt {
  opts: PtySpawnOptions;
  label: string;
}

function buildSpawnLadder(cwd: string): SpawnAttempt[] {
  // Default CLI selection. Set THEORCHESTRA_DEFAULT_CLI=claude to spawn claude;
  // default is "shell" (safer for dev — avoids any collision with external
  // `claude --continue` sessions the user may already have running).
  const mode = (process.env.THEORCHESTRA_DEFAULT_CLI ?? 'shell').toLowerCase();
  const ladder: SpawnAttempt[] = [];

  if (mode === 'claude') {
    if (isOnPath('claude')) {
      ladder.push({
        label: 'claude (direct on PATH)',
        opts: { cli: 'claude', args: [], cwd, tabTitle: 'claude' },
      });
    }
    if (IS_WINDOWS) {
      ladder.push({
        label: 'cmd.exe /c claude',
        opts: { cli: 'cmd.exe', args: ['/c', 'claude'], cwd, tabTitle: 'claude' },
      });
    }
  }

  // Shell fallback is always present. It is the default in "shell" mode and
  // the safety net in "claude" mode if no claude invocation resolves.
  if (IS_WINDOWS) {
    ladder.push({
      label: 'cmd.exe (shell)',
      opts: { cli: 'cmd.exe', args: [], cwd, tabTitle: 'cmd' },
    });
  } else {
    ladder.push({
      label: 'bash (shell)',
      opts: { cli: 'bash', args: [], cwd, tabTitle: 'bash' },
    });
  }

  return ladder;
}

function spawnDefaultSession(manager: PtyManager): SessionRecord {
  const cwd = defaultCwd();
  const ladder = buildSpawnLadder(cwd);

  const errors: string[] = [];
  for (const attempt of ladder) {
    try {
      const rec = manager.spawn(attempt.opts);
      console.log(`[theorchestra] spawn strategy: ${attempt.label} (pid=${rec.pid})`);
      return rec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${attempt.label}: ${msg}`);
    }
  }

  throw new Error(
    `[theorchestra] failed to spawn any default session. Attempts:\n  - ${errors.join('\n  - ')}`,
  );
}

async function main(): Promise<void> {
  const manager = new PtyManager();

  // Phase 6 — session manifest persistence + respawn. Must be wired BEFORE
  // the default-session spawn so the boot-time spawn also lands on disk.
  const manifestDir =
    process.env.THEORCHESTRA_SESSIONS_DIR ?? path.resolve('vault', '_sessions');
  const manifestStore = new SessionManifestStore(manifestDir);
  attachManifestWriter(manager, manifestStore);

  // Cold-start respawn pass — before spawning a fresh default session,
  // recover any sessions whose pid is no longer alive.
  const respawned = respawnDeadSessions(manager, manifestStore);
  if (respawned.length > 0) {
    console.log(
      `[theorchestra] respawned ${respawned.length} session(s) from manifest: ` +
        respawned.map((r) => `${r.oldSessionId.slice(0, 8)}→${r.newSessionId.slice(0, 8)} (${r.strategy})`).join(', '),
    );
  }

  const defaultSession = spawnDefaultSession(manager);

  const port = Number.parseInt(process.env.THEORCHESTRA_PORT ?? '', 10) || DEFAULT_DASHBOARD_PORT;
  const { server, bus } = await startServer(manager, port);

  // Attach the Phase 3 event emitters. Each returns a disposer we'd call on
  // shutdown; we just drop them for now (process exit tears everything down).
  attachStatusBarEmitter(manager, bus);
  attachA2aScanner(manager, bus);
  attachStuckEmitter(manager, bus);
  const tasksPath =
    process.env.THEORCHESTRA_TASKS_FILE ?? path.resolve('vault', 'active_tasks.md');
  attachTasksWatcher(bus, tasksPath);
  console.log(`[theorchestra] SSE emitters attached; tasks watcher on ${tasksPath}`);
  console.log(`[theorchestra] session manifests at ${manifestDir}`);

  console.log(
    `[theorchestra] listening on :${port}, default session ${defaultSession.sessionId}`,
  );

  let shuttingDown = false;
  const skipKill = process.env.THEORCHESTRA_NO_KILL_ON_SHUTDOWN === '1';
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[theorchestra] received ${signal}, shutting down…`);
    if (skipKill) {
      console.log('[theorchestra] THEORCHESTRA_NO_KILL_ON_SHUTDOWN=1 — leaving PTYs as orphans');
    } else {
      const ids = manager.list().map((r) => r.sessionId);
      console.log(`[theorchestra] killing ${ids.length} managed PTY(s): ${ids.join(', ')}`);
      try {
        manager.killAll();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[theorchestra] killAll error: ${msg}`);
      }
    }
    server.close((err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[theorchestra] server.close error: ${msg}`);
        process.exit(1);
      }
      process.exit(0);
    });
    // Safety net: if close hangs, hard-exit after 3s.
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[theorchestra] fatal: ${msg}`);
  process.exit(1);
});
