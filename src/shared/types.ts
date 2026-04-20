/**
 * Shared contract between v3.0 backend (Node PTY server) and frontend (React/xterm renderer).
 *
 * Phase 1 scope: the minimum wire protocol to spawn one PTY, stream output, accept input,
 * and replay scrollback on reconnect. Later phases extend without breaking these shapes.
 */

export type SessionId = string;

export interface PtySpawnOptions {
  cli: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  tabTitle?: string;
  /** Persona name (Phase 5 wiring; Phase 2 stores it on the record). */
  persona?: string | null;
  /** Claude Code --permission-mode value. */
  permissionMode?: string | null;
  /** SessionId of the coordinator pane that spawned this peer. */
  spawnedByPaneId?: string | null;
}

export interface SessionRecord {
  sessionId: SessionId;
  cli: string;
  cwd: string;
  tabTitle: string;
  spawnedAt: string;
  pid: number;
  /**
   * Optional persona name (from `~/.claude/agents/<persona>.md`) if the session
   * was spawned with one. Phase 2 accepts the field at the MCP layer;
   * Phase 5 wires full persona injection.
   */
  persona?: string | null;
  /**
   * Claude Code --permission-mode flag, if the caller provided one at spawn
   * time. One of: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'.
   */
  permissionMode?: string | null;
  /**
   * If the session was spawned as a peer of another pane, the coordinator's
   * sessionId. Enables the v2.7 [PEER-PANE CONTEXT] bootstrap pattern.
   */
  spawnedByPaneId?: string | null;
}

export type SessionStatus = 'idle' | 'working' | 'exited';

export interface SessionStatusDetail {
  sessionId: SessionId;
  status: SessionStatus;
  exitCode: number | null;
  exitSignal: number | null;
  lastOutputAt: string | null;
  lastLines: string[];
  /**
   * Latest raw ctx% parsed from the status bar (0..100), or null if the TUI
   * hasn't rendered a `Ctx: X%` line yet (fresh Claude, non-Claude pane).
   * Source: `src/backend/event-emitters/status-bar.ts`.
   */
  ctxPercent: number | null;
}

/**
 * WebSocket messages are JSON strings framing either text or structured events.
 * Binary frames are reserved for future use (e.g., large scrollback replay).
 */
export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'hello'; session: SessionRecord; scrollback: string }
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null; signal: number | null }
  | { type: 'error'; reason: string }
  | { type: 'pong' };

export const WS_PATH_PREFIX = '/ws/pty/';
export const DEFAULT_DASHBOARD_PORT = 4300;
export const RING_BUFFER_LINES = 10_000;

/**
 * Threshold below which a session is still considered "working": if output has
 * landed within this many milliseconds of now, we treat the session as active.
 * Phase 3 (a11y-tree + SSE pane_idle event) replaces this heuristic with a
 * deterministic signal.
 */
export const WORKING_THRESHOLD_MS = 3_000;

/**
 * SSE event bus schema (ADR-003 + addendum). Omniclaude and the dashboard
 * both subscribe to these events over GET /events. Every event has an `id`
 * (monotonic per server run) and a `ts` (ISO-8601) for correlation.
 */
export type SseEvent =
  | { id: number; ts: string; type: 'pane_idle'; sessionId: SessionId }
  | { id: number; ts: string; type: 'permission_prompt'; sessionId: SessionId; promptText: string }
  | { id: number; ts: string; type: 'peer_orphaned'; sessionId: SessionId; deadPeer: SessionId; corr: string }
  | {
      id: number;
      ts: string;
      type: 'ctx_threshold';
      sessionId: SessionId;
      percent: number;
      /**
       * 40 = suggest (toast), 60 = critical (modal), 70 = automatic
       * (backend auto-runs auto-handoff after the readiness gate). The
       * older 30/50 thresholds are retained for compatibility with
       * historical events — new emissions use 40/60/70.
       */
      crossed: 30 | 40 | 50 | 60 | 70;
    }
  | {
      id: number;
      ts: string;
      type: 'a2a_received';
      sessionId: SessionId;
      from: string;
      to: string;
      corr: string;
      envelopeType: 'request' | 'ack' | 'progress' | 'result' | 'error';
    }
  | { id: number; ts: string; type: 'pane_stuck'; sessionId: SessionId; idleMs: number }
  | {
      id: number;
      ts: string;
      type: 'task_dispatched';
      taskId: string;
      owner: string | null;
      path: string;
    }
  | {
      id: number;
      ts: string;
      type: 'task_completed';
      taskId: string;
      owner: string | null;
      path: string;
    };

export type SseEventType = SseEvent['type'];

export const SSE_EVENT_TYPES: readonly SseEventType[] = [
  'pane_idle',
  'permission_prompt',
  'peer_orphaned',
  'ctx_threshold',
  'a2a_received',
  'pane_stuck',
  'task_dispatched',
  'task_completed',
] as const;

/** Default pane_stuck threshold — 10 min of "working" with no output change. */
export const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
