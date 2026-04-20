import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { Terminal } from './Terminal';
import { ChatPanel } from './ChatPanel';
import { Login } from './Login';
import { authedFetch, checkAuth, clearToken } from './auth';

type Status =
  | { kind: 'auth-checking' }
  | { kind: 'auth-required' }
  | { kind: 'loading' }
  | { kind: 'waiting' }
  | { kind: 'ready'; session: SessionRecord }
  | { kind: 'error'; message: string };

const POLL_INTERVAL_MS = 1000;
const NARROW_VIEWPORT_PX = 800;

type NarrowView = 'terminal' | 'chat';

export function App() {
  const [status, setStatus] = useState<Status>({ kind: 'auth-checking' });
  const [isNarrow, setIsNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < NARROW_VIEWPORT_PX : false,
  );
  const [narrowView, setNarrowView] = useState<NarrowView>('terminal');
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const fetchOnce = async (): Promise<SessionRecord[]> => {
      const res = await authedFetch('/api/sessions');
      if (res.status === 401) {
        throw new Error('unauthorized');
      }
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
          setStatus({ kind: 'ready', session: sessions[0]! });
          return;
        }
        setStatus({ kind: 'waiting' });
        setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelledRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'unauthorized') {
          clearToken();
          setStatus({ kind: 'auth-required' });
          return;
        }
        setStatus({ kind: 'error', message });
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    const bootstrap = async () => {
      const auth = await checkAuth();
      if (cancelledRef.current) return;
      if (auth.required && !auth.tokenValid) {
        setStatus({ kind: 'auth-required' });
        return;
      }
      setStatus({ kind: 'loading' });
      void poll();
    };

    void bootstrap();

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

  if (status.kind === 'auth-checking') {
    return (
      <div className="app">
        <div className="app-status">Checking auth...</div>
      </div>
    );
  }

  if (status.kind === 'auth-required') {
    return (
      <Login
        onAuthenticated={() => {
          // Re-bootstrap by reloading the status engine.
          setStatus({ kind: 'loading' });
          // Kick off a new poll loop.
          const reboot = async () => {
            try {
              const res = await authedFetch('/api/sessions');
              if (res.ok) {
                const list = (await res.json()) as SessionRecord[];
                if (list.length > 0) setStatus({ kind: 'ready', session: list[0]! });
                else setStatus({ kind: 'waiting' });
              } else {
                setStatus({ kind: 'error', message: `HTTP ${res.status}` });
              }
            } catch (err) {
              setStatus({
                kind: 'error',
                message: err instanceof Error ? err.message : String(err),
              });
            }
          };
          void reboot();
        }}
      />
    );
  }

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
