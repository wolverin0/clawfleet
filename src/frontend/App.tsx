import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { Terminal } from './Terminal';
import { ChatPanel } from './ChatPanel';

type Status =
  | { kind: 'loading' }
  | { kind: 'waiting' }
  | { kind: 'ready'; session: SessionRecord }
  | { kind: 'error'; message: string };

const POLL_INTERVAL_MS = 1000;
const NARROW_VIEWPORT_PX = 800;

type NarrowView = 'terminal' | 'chat';

export function App() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [isNarrow, setIsNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < NARROW_VIEWPORT_PX : false,
  );
  const [narrowView, setNarrowView] = useState<NarrowView>('terminal');
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const fetchOnce = async (): Promise<SessionRecord[]> => {
      const res = await fetch('/api/sessions');
      if (!res.ok) {
        throw new Error(`GET /api/sessions failed: ${res.status}`);
      }
      return (await res.json()) as SessionRecord[];
    };

    const poll = async () => {
      try {
        const sessions = await fetchOnce();
        if (cancelledRef.current) return;
        if (sessions.length > 0) {
          setStatus({ kind: 'ready', session: sessions[0] });
          return;
        }
        setStatus({ kind: 'waiting' });
        setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelledRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ kind: 'error', message });
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    void poll();

    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      setIsNarrow(window.innerWidth < NARROW_VIEWPORT_PX);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  if (status.kind === 'ready') {
    if (isNarrow) {
      const showChat = narrowView === 'chat';
      return (
        <div className="app app-narrow">
          <div className="app-toggle">
            <button
              type="button"
              className={narrowView === 'terminal' ? 'app-toggle-btn active' : 'app-toggle-btn'}
              onClick={() => setNarrowView('terminal')}
            >
              Terminal
            </button>
            <button
              type="button"
              className={narrowView === 'chat' ? 'app-toggle-btn active' : 'app-toggle-btn'}
              onClick={() => setNarrowView('chat')}
            >
              Chat
            </button>
          </div>
          <div className="app-narrow-body">
            {showChat ? (
              <ChatPanel />
            ) : (
              <Terminal sessionId={status.session.sessionId} />
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="app app-wide">
        <div className="app-terminal">
          <Terminal sessionId={status.session.sessionId} />
        </div>
        <div className="app-chat">
          <ChatPanel />
        </div>
      </div>
    );
  }

  const message =
    status.kind === 'loading'
      ? 'Loading...'
      : status.kind === 'waiting'
        ? 'Waiting for session...'
        : `Error: ${status.message}`;

  return (
    <div className="app">
      <div className="app-status">{message}</div>
    </div>
  );
}
