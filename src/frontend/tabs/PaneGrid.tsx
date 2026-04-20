import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { authedFetch } from '../auth';
import { PaneCard } from './PaneCard';

/**
 * U2 — pane grid. Polls `/api/sessions` every 3s and renders one PaneCard
 * per live session in a 2-column responsive grid. Replaces the U0
 * Terminal+ChatPanel split as the Sessions-tab body.
 */

export function PaneGrid() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = async (): Promise<void> => {
    try {
      const res = await authedFetch('/api/sessions');
      if (!res.ok) {
        setLastError(`HTTP ${res.status}`);
        return;
      }
      const list = (await res.json()) as SessionRecord[];
      if (cancelledRef.current) return;
      setSessions(list);
      setLastError(null);
      if (activeId && !list.some((s) => s.sessionId === activeId)) {
        setActiveId(list[0]?.sessionId ?? null);
      } else if (!activeId && list.length > 0) {
        setActiveId(list[0]!.sessionId);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setLastError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    const handle = setInterval(() => void refresh(), 3000);
    return () => {
      cancelledRef.current = true;
      clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (sessions.length === 0) {
    return (
      <div className="pane-grid-empty">
        <div className="pane-grid-empty-title">No sessions yet</div>
        <div className="pane-grid-empty-body">
          Use the <strong>Spawn</strong> tab to open a new Claude / Codex / shell pane.
        </div>
        {lastError && <div className="pane-grid-empty-err">{lastError}</div>}
      </div>
    );
  }

  return (
    <div className="pane-grid" role="list">
      {sessions.map((s) => (
        <div role="listitem" key={s.sessionId} className="pane-grid-cell">
          <PaneCard
            session={s}
            active={s.sessionId === activeId}
            onSelect={() => setActiveId(s.sessionId)}
            onKill={() => void refresh()}
          />
        </div>
      ))}
    </div>
  );
}
