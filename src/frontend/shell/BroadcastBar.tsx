import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { authedFetch } from '../auth';

/**
 * U4 — broadcast-to-all-sessions bar + cross-pane project badges.
 *
 * The bar sits above the Sessions tab grid. Typing text + Broadcast posts
 * the prompt to every live session in sequence. The project-code badges
 * at the bottom-right float over the content and show 2-letter codes for
 * each live session so the user can tell at a glance what's running.
 */

function twoLetterCode(rec: SessionRecord): string {
  const name = (rec.tabTitle || rec.cli || '??').replace(/[^A-Za-z0-9]/g, '');
  if (name.length === 0) return '??';
  if (name.length === 1) return name.toUpperCase();
  return (name[0]! + name[1]!).toUpperCase();
}

export function BroadcastBar() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await authedFetch('/api/sessions');
        if (!res.ok) return;
        const list = (await res.json()) as SessionRecord[];
        if (cancelledRef.current) return;
        setSessions(list);
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

  const broadcast = async (): Promise<void> => {
    const payload = text.trim();
    if (!payload || busy) return;
    setBusy(true);
    setLastResult(null);
    let ok = 0;
    let fail = 0;
    for (const s of sessions) {
      try {
        const r = await authedFetch(
          `/api/sessions/${encodeURIComponent(s.sessionId)}/prompt`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: payload }),
          },
        );
        if (r.ok) ok += 1;
        else fail += 1;
      } catch {
        fail += 1;
      }
    }
    setLastResult(`broadcast: ${ok} ok, ${fail} failed`);
    setText('');
    setBusy(false);
  };

  return (
    <>
      <div className="broadcast-bar">
        <input
          type="text"
          className="broadcast-input"
          placeholder={`Broadcast to all ${sessions.length} session${sessions.length === 1 ? '' : 's'}…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void broadcast();
            }
          }}
          disabled={busy || sessions.length === 0}
          aria-label="Broadcast message"
        />
        <button
          type="button"
          className="broadcast-btn"
          onClick={() => void broadcast()}
          disabled={busy || !text.trim() || sessions.length === 0}
        >
          {busy ? 'Sending…' : 'Broadcast'}
        </button>
        {lastResult && <span className="broadcast-result">{lastResult}</span>}
      </div>
      {sessions.length > 0 && (
        <div className="pane-badges" aria-label="Active sessions">
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              className="pane-badge"
              title={`${s.tabTitle || s.cli} (${s.sessionId.slice(0, 8)})`}
            >
              {twoLetterCode(s)}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
