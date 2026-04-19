import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { Terminal } from './Terminal';

type Status =
  | { kind: 'loading' }
  | { kind: 'waiting' }
  | { kind: 'ready'; session: SessionRecord }
  | { kind: 'error'; message: string };

const POLL_INTERVAL_MS = 1000;

export function App() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
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

  if (status.kind === 'ready') {
    return (
      <div className="app">
        <Terminal sessionId={status.session.sessionId} />
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
