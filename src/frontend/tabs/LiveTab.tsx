import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { authedFetch } from '../auth';
import { Terminal } from '../Terminal';
import { ChatPanel } from '../ChatPanel';

/**
 * U2 interim — the Live tab temporarily hosts the full-screen Terminal +
 * ChatPanel so those features stay live while the Sessions tab hosts the
 * pane-card grid. U3 replaces this with the activity sidebar (OmniClaude /
 * A2A / Events) and moves the chat into that sidebar.
 */

export function LiveTab() {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await authedFetch('/api/sessions');
        if (!res.ok) return;
        const list = (await res.json()) as SessionRecord[];
        if (cancelledRef.current) return;
        setSession(list[0] ?? null);
      } catch {
        /* transient */
      }
    };
    void poll();
    const handle = setInterval(() => void poll(), 3000);
    return () => {
      cancelledRef.current = true;
      clearInterval(handle);
    };
  }, []);

  if (!session) {
    return (
      <div className="tab-placeholder">
        <div className="tab-placeholder-title">Live</div>
        <div className="tab-placeholder-body">Waiting for a session…</div>
      </div>
    );
  }

  return (
    <div className="live-tab">
      <div className="live-tab-terminal">
        <Terminal sessionId={session.sessionId} />
      </div>
      <div className="live-tab-chat">
        <ChatPanel />
      </div>
    </div>
  );
}
