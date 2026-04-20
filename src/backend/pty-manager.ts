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
// @xterm/headless is ESM-only but tsx transparently resolves it in CJS mode.
import { Terminal as HeadlessTerminal } from '@xterm/headless';

import {
  RING_BUFFER_LINES,
  WORKING_THRESHOLD_MS,
  type PtySpawnOptions,
  type SessionId,
  type SessionRecord,
  type SessionStatus,
  type SessionStatusDetail,
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
  /** Last exit code and signal, if the pty has exited. */
  exitCode: number | null;
  exitSignal: number | null;
  /** Timestamp (ms epoch) of the last `data` event from the pty. */
  lastDataAt: number | null;
  /**
   * Headless xterm parser — fed every PTY chunk. Lets us answer
   * `renderedBuffer(id)` with the exact text xterm.js renders in the browser.
   * Per ADR-003 addendum; replaces the Rust agent-browser CDP path.
   */
  headless: HeadlessTerminal;
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
  /** The exact argv we passed to node-pty — useful for manifest persistence. */
  spawnArgs: string[];
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
      persona: opts.persona ?? null,
      permissionMode: opts.permissionMode ?? null,
      spawnedByPaneId: opts.spawnedByPaneId ?? null,
    };

    const headless = new HeadlessTerminal({
      cols,
      rows,
      scrollback: RING_BUFFER_LINES,
      allowProposedApi: true,
    });

    const entry: PtyEntry = {
      record,
      pty: child,
      ring: [],
      current: '',
      exited: false,
      exitCode: null,
      exitSignal: null,
      lastDataAt: null,
      headless,
    };
    this.sessions.set(sessionId, entry);

    child.onData((chunk: string) => {
      entry.lastDataAt = Date.now();
      this.ingest(entry, chunk);
      // Feed the headless xterm so renderedBuffer(id) mirrors what the
      // browser's xterm.js would display. Non-fatal if this throws.
      try {
        entry.headless.write(chunk);
      } catch {
        /* swallow — an emitter hiccup here must not take down the data path */
      }
      this.emit('data', { sessionId, data: chunk } satisfies PtyDataEvent);
    });

    child.onExit(({ exitCode, signal }) => {
      entry.exited = true;
      entry.exitCode = exitCode ?? null;
      entry.exitSignal = signal ?? null;
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

    this.emit('spawn', { sessionId, record, spawnArgs: opts.args ?? [] } satisfies PtySpawnEvent);
    return record;
  }

  /**
   * Public, operational cousin of `_injectForTest`: write a one-line banner
   * into the session's ring buffer and frontend stream without running it
   * through the PTY. Used for post-respawn messages like
   * "[theorchestra] pane resumed at ...".
   *
   * Unlike the test helper, this does NOT touch lastDataAt so emitter state
   * (idle/working, pane_stuck streak) is unaffected.
   */
  injectBanner(id: SessionId, text: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    const chunk = text.endsWith('\r\n') ? text : text + '\r\n';
    this.ingest(entry, chunk);
    try {
      entry.headless.write(chunk);
    } catch {
      /* ignore */
    }
    this.emit('data', { sessionId: id, data: chunk } satisfies PtyDataEvent);
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
    // Keep the headless parser in lockstep so line wrapping matches the
    // browser's rendering. Only required for accurate renderedBuffer() output.
    try {
      entry.headless.resize(safeCols, safeRows);
    } catch {
      /* headless terminal may have been disposed; ignore */
    }
  }

  /**
   * The rendered text buffer, per ADR-003 addendum. Returns the visible
   * terminal contents (including scrollback) as one string per row, trimmed
   * of trailing whitespace. This matches what xterm.js renders in the
   * browser, so emitters + omniclaude see the same text the user sees.
   */
  renderedBuffer(id: SessionId): string[] {
    const entry = this.sessions.get(id);
    if (!entry) return [];
    const buf = entry.headless.buffer.active;
    const lines: string[] = [];
    const total = buf.length;
    for (let i = 0; i < total; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  /** Last N rendered lines (skipping leading blanks). */
  renderedTail(id: SessionId, n: number): string[] {
    const all = this.renderedBuffer(id);
    const nonEmpty = all.filter((l) => l.length > 0);
    const count = Math.max(0, Math.min(n, nonEmpty.length));
    return nonEmpty.slice(nonEmpty.length - count);
  }

  scrollback(id: SessionId): string {
    const entry = this.sessions.get(id);
    if (!entry) return '';
    if (entry.current.length === 0) {
      return entry.ring.join('\n');
    }
    return [...entry.ring, entry.current].join('\n');
  }

  /** Return the last `n` scrollback lines (including the in-progress tail). */
  scrollbackTail(id: SessionId, n: number): string[] {
    const entry = this.sessions.get(id);
    if (!entry) return [];
    const allLines = entry.current.length > 0
      ? [...entry.ring, entry.current]
      : entry.ring;
    const count = Math.max(0, Math.min(n, allLines.length));
    return allLines.slice(allLines.length - count);
  }

  /**
   * Derive a coarse session status. Phase 2 heuristic:
   *   exited      → pty has exited
   *   working     → output landed within WORKING_THRESHOLD_MS
   *   idle        → everything else (including "never produced output yet")
   *
   * Phase 3 (ADR-003) replaces this with a11y-tree + SSE deterministic signals.
   */
  status(id: SessionId): SessionStatus {
    const entry = this.sessions.get(id);
    if (!entry) return 'exited';
    if (entry.exited) return 'exited';
    if (entry.lastDataAt === null) return 'idle';
    return Date.now() - entry.lastDataAt < WORKING_THRESHOLD_MS ? 'working' : 'idle';
  }

  statusDetail(id: SessionId): SessionStatusDetail | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    // Use xterm-headless rendered output so callers get clean text (ANSI
    // escape sequences already interpreted) instead of raw PTY bytes.
    return {
      sessionId: id,
      status: this.status(id),
      exitCode: entry.exitCode,
      exitSignal: entry.exitSignal,
      lastOutputAt: entry.lastDataAt === null ? null : new Date(entry.lastDataAt).toISOString(),
      lastLines: this.renderedTail(id, 20),
    };
  }

  setTabTitle(id: SessionId, title: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    entry.record.tabTitle = title;
    return true;
  }

  /**
   * Test-only: bypass the child PTY and inject a data chunk directly into
   * the ring buffer, headless terminal, and event stream. Used by Phase 3
   * gate harnesses and future emitter tests that need deterministic output
   * without depending on the underlying shell's echo/prompt behaviour.
   */
  _injectForTest(id: SessionId, chunk: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    entry.lastDataAt = Date.now();
    this.ingest(entry, chunk);
    try {
      entry.headless.write(chunk);
    } catch {
      /* ignore */
    }
    this.emit('data', { sessionId: id, data: chunk } satisfies PtyDataEvent);
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
    try {
      entry.headless.dispose();
    } catch {
      /* already disposed */
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
