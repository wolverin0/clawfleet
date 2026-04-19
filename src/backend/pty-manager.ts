/**
 * PtyManager — spawns node-pty processes, buffers output in a per-session ring
 * buffer, and emits events for the WebSocket layer to broadcast.
 *
 * Phase 1 scope: in-memory only. No disk persistence, no reattach. A dashboard
 * restart terminates every pty. Phase 6 (`docs/adrs/v3.0-004-pty-durability.md`)
 * adds the manifest + respawn-with-`--continue` story on top of this surface.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

import {
  RING_BUFFER_LINES,
  type PtySpawnOptions,
  type SessionId,
  type SessionRecord,
} from '../shared/types.js';

interface PtyEntry {
  record: SessionRecord;
  pty: IPty;
  /** Completed lines, oldest first. Length capped at RING_BUFFER_LINES. */
  ring: string[];
  /** Accumulator for the in-progress (not-yet-newlined) tail line. */
  current: string;
  /** Whether the process has exited; set true on first exit event. */
  exited: boolean;
}

export interface PtyDataEvent {
  sessionId: SessionId;
  data: string;
}

export interface PtyExitEvent {
  sessionId: SessionId;
  code: number | null;
  signal: number | null;
}

export interface PtySpawnEvent {
  sessionId: SessionId;
  record: SessionRecord;
}

export class PtyManager extends EventEmitter {
  private readonly sessions = new Map<SessionId, PtyEntry>();

  spawn(opts: PtySpawnOptions): SessionRecord {
    const sessionId = randomUUID();
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 30;
    const cwd = opts.cwd ?? process.cwd();
    const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
    const tabTitle = opts.tabTitle ?? opts.cli;

    const child = pty.spawn(opts.cli, opts.args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      handleFlowControl: true,
    });

    const record: SessionRecord = {
      sessionId,
      cli: opts.cli,
      cwd,
      tabTitle,
      spawnedAt: new Date().toISOString(),
      pid: child.pid ?? -1,
    };

    const entry: PtyEntry = {
      record,
      pty: child,
      ring: [],
      current: '',
      exited: false,
    };
    this.sessions.set(sessionId, entry);

    child.onData((chunk: string) => {
      this.ingest(entry, chunk);
      this.emit('data', { sessionId, data: chunk } satisfies PtyDataEvent);
    });

    child.onExit(({ exitCode, signal }) => {
      entry.exited = true;
      // Flush any trailing non-newlined text into the ring so scrollback is
      // complete after process exit.
      if (entry.current.length > 0) {
        this.pushLine(entry, entry.current);
        entry.current = '';
      }
      this.emit('exit', {
        sessionId,
        code: exitCode ?? null,
        signal: signal ?? null,
      } satisfies PtyExitEvent);
    });

    this.emit('spawn', { sessionId, record } satisfies PtySpawnEvent);
    return record;
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values()).map((e) => e.record);
  }

  get(id: SessionId): SessionRecord | undefined {
    return this.sessions.get(id)?.record;
  }

  write(id: SessionId, data: string): void {
    const entry = this.sessions.get(id);
    if (!entry || entry.exited) return;
    entry.pty.write(data);
  }

  resize(id: SessionId, cols: number, rows: number): void {
    const entry = this.sessions.get(id);
    if (!entry || entry.exited) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    try {
      entry.pty.resize(safeCols, safeRows);
    } catch {
      // PTY may have exited between our check and the resize call; ignore.
    }
  }

  scrollback(id: SessionId): string {
    const entry = this.sessions.get(id);
    if (!entry) return '';
    if (entry.current.length === 0) {
      return entry.ring.join('\n');
    }
    return [...entry.ring, entry.current].join('\n');
  }

  kill(id: SessionId): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    if (!entry.exited) {
      try {
        entry.pty.kill();
      } catch {
        // Already dead — onExit will fire and mark exited.
      }
    }
    this.sessions.delete(id);
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.kill(id);
    }
  }

  /**
   * Append a chunk into the ring buffer, splitting on `\n`. Lines push to the
   * ring; the trailing partial (post-last-\n) stays in `current` until the
   * next chunk completes it.
   */
  private ingest(entry: PtyEntry, chunk: string): void {
    let buffer = entry.current + chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      // Strip a trailing \r for CRLF streams so scrollback isn't doubly spaced.
      let line = buffer.slice(0, idx);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.pushLine(entry, line);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
    entry.current = buffer;
  }

  private pushLine(entry: PtyEntry, line: string): void {
    entry.ring.push(line);
    if (entry.ring.length > RING_BUFFER_LINES) {
      entry.ring.splice(0, entry.ring.length - RING_BUFFER_LINES);
    }
  }
}
