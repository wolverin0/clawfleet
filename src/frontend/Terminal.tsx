import { useEffect, useRef, useState } from 'react';
import { Terminal as WTerm, useTerminal } from '@wterm/react';
import '@wterm/react/css';
import type { ClientMessage, ServerMessage } from '@shared/types';
import { wsUrl } from './auth';

/**
 * Terminal renderer for a single PTY session.
 *
 * Uses `@wterm/react` (vercel-labs/wterm) — a Zig/WASM terminal emulator
 * that renders to the DOM, giving native browser text selection +
 * Ctrl+F find + a real a11y tree out of the box. See
 * `docs/REMEDIATION.md` for the pivot rationale from `@xterm/xterm`.
 *
 * Scrollback replay + exponential-backoff reconnect are preserved
 * identically to the earlier xterm.js implementation.
 */

interface TerminalProps {
  sessionId: string;
}

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 10000;

// Per-session WebSocket registry so the onData/onResize callbacks can
// reach the current socket without recreating them on every render.
declare global {
  // eslint-disable-next-line no-var
  var __wtermWs: Record<string, WebSocket | null> | undefined;
}

function getWs(sessionId: string): WebSocket | null {
  return globalThis.__wtermWs?.[sessionId] ?? null;
}

function setWs(sessionId: string, ws: WebSocket | null): void {
  if (!globalThis.__wtermWs) globalThis.__wtermWs = {};
  globalThis.__wtermWs[sessionId] = ws;
}

export function Terminal({ sessionId }: TerminalProps) {
  const { ref, write } = useTerminal();
  const [ready, setReady] = useState(false);
  const writeRef = useRef(write);
  writeRef.current = write;

  // Track the latest cols/rows reported by onResize so the reconnect
  // handshake can send current geometry on `hello`.
  const geomRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });

  useEffect(() => {
    if (!ready) return;
    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const safeSend = (msg: ClientMessage): void => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const sendResize = (): void => {
      const { cols, rows } = geomRef.current;
      safeSend({ type: 'resize', cols, rows });
    };

    const writeBanner = (text: string, color: string): void => {
      writeRef.current(`\r\n\x1b[${color}m${text}\x1b[0m\r\n`);
    };

    const handleServerMessage = (raw: unknown): void => {
      if (typeof raw !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw) as ServerMessage;
      } catch (err) {
        console.warn('[Terminal] malformed server frame', err);
        return;
      }
      switch (msg.type) {
        case 'hello':
          if (msg.scrollback) writeRef.current(msg.scrollback);
          sendResize();
          break;
        case 'data':
          writeRef.current(msg.data);
          break;
        case 'exit': {
          const codeStr = msg.code === null ? 'null' : String(msg.code);
          const signalStr = msg.signal === null ? '' : ` signal=${msg.signal}`;
          writeBanner(`[process exited code=${codeStr}${signalStr}]`, '33');
          break;
        }
        case 'error':
          console.warn('[Terminal] server error:', msg.reason);
          break;
        case 'pong':
          break;
        default: {
          const _never: never = msg;
          void _never;
        }
      }
    };

    const connect = (): void => {
      if (disposed) return;
      ws = new WebSocket(wsUrl(sessionId));
      setWs(sessionId, ws);
      ws.onopen = () => {
        reconnectAttempt = 0;
      };
      ws.onmessage = (ev) => handleServerMessage(ev.data);
      ws.onerror = () => {
        /* close handler drives reconnect */
      };
      ws.onclose = () => {
        if (disposed) return;
        writeBanner('[disconnected — retrying...]', '31');
        const delay = Math.min(
          RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
          RECONNECT_MAX_MS,
        );
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* teardown */
        }
      }
      setWs(sessionId, null);
    };
  }, [ready, sessionId]);

  return (
    <WTerm
      // @wterm/react@0.1.9 has an internal type mismatch — `useTerminal`
      // returns `RefObject<TerminalHandle | null>` but `<Terminal>` expects
      // `RefObject<TerminalHandle>`. Runtime works; cast to satisfy tsc.
      ref={ref as unknown as React.RefObject<import('@wterm/react').TerminalHandle>}
      className="term"
      autoResize
      cursorBlink
      onData={(data: string) => {
        const ws = getWs(sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data } satisfies ClientMessage));
        }
      }}
      onResize={(cols, rows) => {
        geomRef.current = { cols, rows };
        const ws = getWs(sessionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: 'resize', cols, rows } satisfies ClientMessage),
          );
        }
      }}
      onReady={() => setReady(true)}
    />
  );
}
