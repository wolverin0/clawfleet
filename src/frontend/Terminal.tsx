import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ClientMessage, ServerMessage } from '@shared/types';

interface TerminalProps {
  sessionId: string;
}

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 10000;

export function Terminal({ sessionId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      screenReaderMode: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: { background: '#0b0b0b', foreground: '#dddddd' },
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // Initial fit after mount — container has real dimensions now.
    try {
      fit.fit();
    } catch {
      // Container may not have layout yet; resize observer will retry.
    }

    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const safeSend = (msg: ClientMessage) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const sendResize = () => {
      safeSend({ type: 'resize', cols: term.cols, rows: term.rows });
    };

    const onWindowResize = () => {
      try {
        fit.fit();
        sendResize();
      } catch {
        // Ignore transient layout errors.
      }
    };
    window.addEventListener('resize', onWindowResize);

    // ResizeObserver handles container-size changes that window resize misses
    // (e.g., Vite HMR, flexbox reflow before layout settles).
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResize();
      } catch {
        // Ignore transient layout errors.
      }
    });
    ro.observe(container);

    const dataDisposable = term.onData((d) => {
      safeSend({ type: 'input', data: d });
    });

    const writeBanner = (text: string, color: string) => {
      // ANSI: \x1b[<color>m ... \x1b[0m, plus CRLF for clean new line.
      term.write(`\r\n\x1b[${color}m${text}\x1b[0m\r\n`);
    };

    const handleServerMessage = (raw: unknown) => {
      if (typeof raw !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw) as ServerMessage;
      } catch (err) {
        console.warn('[Terminal] malformed server frame', err);
        return;
      }
      switch (msg.type) {
        case 'hello': {
          // Scrollback MUST be written before any subsequent data frames.
          if (msg.scrollback) term.write(msg.scrollback);
          // After replay, tell backend our current geometry.
          sendResize();
          break;
        }
        case 'data': {
          term.write(msg.data);
          break;
        }
        case 'exit': {
          const codeStr = msg.code === null ? 'null' : String(msg.code);
          const signalStr = msg.signal === null ? '' : ` signal=${msg.signal}`;
          writeBanner(`[process exited code=${codeStr}${signalStr}]`, '33');
          break;
        }
        case 'error': {
          console.warn('[Terminal] server error:', msg.reason);
          break;
        }
        case 'pong':
          break;
        default: {
          // Exhaustiveness guard — silently ignore unknown future types.
          const _never: never = msg;
          void _never;
        }
      }
    };

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      const url = `${proto}${location.host}/ws/pty/${encodeURIComponent(sessionId)}`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        reconnectAttempt = 0;
      };
      ws.onmessage = (ev) => handleServerMessage(ev.data);
      ws.onerror = () => {
        // Close handler will drive reconnect logic.
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
      window.removeEventListener('resize', onWindowResize);
      ro.disconnect();
      dataDisposable.dispose();
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // Ignore close errors during teardown.
        }
      }
      term.dispose();
    };
  }, [sessionId]);

  return <div className="term" ref={containerRef} />;
}
