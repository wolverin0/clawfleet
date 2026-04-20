import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { authedFetch } from '../auth';

/**
 * U2 — pane-card. Faithful port of v2.x `.dwin` (dashboard window):
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ ● ● ●   project-name          [STATUS] [✕] │  ← header
 *   ├─────────────────────────────────────────────┤
 *   │ last 20 rendered text lines                 │  ← body (monospace)
 *   │                                             │
 *   ├─────────────────────────────────────────────┤
 *   │ [prompt input...................] [Send]   │  ← prompt
 *   └─────────────────────────────────────────────┘
 *
 * Polls `/api/sessions/:id/status` every 2s and re-renders the body + badge.
 * Prompt posts to `/api/sessions/:id/prompt` and clears on success.
 */

interface StatusDetail {
  status: 'idle' | 'working' | 'exited';
  lastLines: string[];
  exitCode: number | null;
  lastOutputAt: string | null;
}

interface PaneCardProps {
  session: SessionRecord;
  active?: boolean;
  onSelect?: () => void;
  onKill?: () => void;
  onHandoff?: () => void;
}

function projectName(cwd: string, tabTitle: string | undefined): string {
  if (tabTitle && tabTitle.length > 0 && tabTitle !== 'cmd' && tabTitle !== 'bash') {
    return tabTitle;
  }
  const normalised = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalised.lastIndexOf('/');
  return idx === -1 ? normalised : normalised.slice(idx + 1);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function PaneCard({ session, active, onSelect, onKill, onHandoff }: PaneCardProps) {
  const [detail, setDetail] = useState<StatusDetail | null>(null);
  const [promptText, setPromptText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await authedFetch(`/api/sessions/${encodeURIComponent(session.sessionId)}/status`);
        if (!res.ok) return;
        const data = (await res.json()) as StatusDetail;
        if (!cancelledRef.current) setDetail(data);
      } catch {
        /* transient */
      }
    };
    void poll();
    const handle = setInterval(() => void poll(), 2000);
    return () => {
      cancelledRef.current = true;
      clearInterval(handle);
    };
  }, [session.sessionId]);

  // Auto-scroll to the bottom when new output arrives.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [detail?.lastLines]);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!promptText.trim() || sending) return;
    setSending(true);
    setErr(null);
    try {
      const res = await authedFetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}/prompt`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: promptText }),
        },
      );
      if (!res.ok) {
        setErr(`send failed: HTTP ${res.status}`);
      } else {
        setPromptText('');
      }
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setSending(false);
    }
  };

  const handleKill = async (): Promise<void> => {
    if (!window.confirm(`Kill pane ${shortId(session.sessionId)}?`)) return;
    try {
      await authedFetch(`/api/sessions/${encodeURIComponent(session.sessionId)}`, {
        method: 'DELETE',
      });
      onKill?.();
    } catch {
      /* user will see card disappear once backend list refreshes */
    }
  };

  const status = detail?.status ?? 'idle';
  const statusLabel = status === 'exited' ? 'EXITED' : status.toUpperCase();
  const lines = detail?.lastLines ?? [];
  const name = projectName(session.cwd, session.tabTitle);

  return (
    <div className={`dwin ${active ? 'active' : ''}`} onClick={onSelect}>
      <div className="dwin-header">
        <div className="dwin-dots" aria-hidden="true">
          <span className="dc" />
          <span className="dm" />
          <span className="dx" />
        </div>
        <span className="dwin-name" title={session.cwd}>
          {name}
        </span>
        <span
          className={`dwin-st ${status}`}
          title={`status: ${status}${detail?.exitCode !== null && detail?.exitCode !== undefined ? ` (exit ${detail.exitCode})` : ''}`}
        >
          {statusLabel}
        </span>
        {onHandoff && (
          <button
            type="button"
            className="dwin-btn"
            onClick={(e) => {
              e.stopPropagation();
              onHandoff();
            }}
            title="Trigger auto-handoff"
          >
            ↗
          </button>
        )}
        <button
          type="button"
          className="dwin-btn dwin-btn-kill"
          onClick={(e) => {
            e.stopPropagation();
            void handleKill();
          }}
          title="Kill pane"
          aria-label="Kill pane"
        >
          ✕
        </button>
      </div>
      <div className="dwin-body" ref={bodyRef}>
        {lines.length === 0 ? (
          <div className="dwin-body-empty">(no output yet)</div>
        ) : (
          lines.map((line, i) => (
            <div className="dwin-line" key={`${session.sessionId}-${i}`}>
              {line || '\u00a0'}
            </div>
          ))
        )}
      </div>
      <form className="dwin-prompt" onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()}>
        <input
          type="text"
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          placeholder={`send to ${name}…`}
          disabled={sending || status === 'exited'}
          spellCheck={false}
          aria-label={`Prompt for ${name}`}
        />
        <button type="submit" disabled={sending || !promptText.trim() || status === 'exited'}>
          Send
        </button>
      </form>
      {err && <div className="dwin-err">{err}</div>}
      <div className="dwin-meta">
        <span className="dwin-meta-item" title="session id">
          {shortId(session.sessionId)}
        </span>
        <span className="dwin-meta-item" title="cli">
          {session.cli}
        </span>
        {session.persona && (
          <span className="dwin-meta-item dwin-meta-persona" title="persona">
            {session.persona}
          </span>
        )}
      </div>
    </div>
  );
}
