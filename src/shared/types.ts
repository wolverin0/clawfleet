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
}

export interface SessionRecord {
  sessionId: SessionId;
  cli: string;
  cwd: string;
  tabTitle: string;
  spawnedAt: string;
  pid: number;
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
