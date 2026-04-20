import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { authedFetch } from '../auth';

/**
 * U2 — pane-card. Port of v2.x `.dwin` (dashboard window).
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ ● ● ●  name  [a2a] [STATUS] [ctx%] [persona]  ↗ 📜 🔄 ✕  │  ← header
 *   ├──────────────────────────────────────────────────────────┤
 *   │ last 20 rendered text lines                              │  ← body
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ESC · ↑ · ↓ · ← · → · Tab · Ctrl+C                       │  ← keys strip
 *   ├──────────────────────────────────────────────────────────┤
 *   │ [prompt ...............] Send · Q+ · Ctx · Mode          │  ← prompt row
 *   └──────────────────────────────────────────────────────────┘
 *
 * Polls `/api/sessions/:id/status` every 2s. Prompt row posts to `/prompt`;
 * keys strip + Mode button post to `/key`. Handoff trio talks to
 * `/api/a2a/handoff`, `/api/handoffs`, `/api/sessions/:id/auto-handoff`.
 */

interface StatusDetail {
  status: 'idle' | 'working' | 'exited';
  lastLines: string[];
  exitCode: number | null;
  lastOutputAt: string | null;
  ctxPercent: number | null;
}

function ctxTier(pct: number): 'low' | 'normal' | 'warn' | 'high' | 'critical' {
  if (pct >= 70) return 'critical';
  if (pct >= 60) return 'high';
  if (pct >= 40) return 'warn';
  if (pct >= 20) return 'normal';
  return 'low';
}

interface HandoffEntry {
  filename: string;
  filepath: string;
  mtime: string | null;
  size: number;
  head: string;
  sent: string | null;
  corr: string | null;
}

interface PaneCardProps {
  session: SessionRecord;
  peerSessions?: SessionRecord[];
  active?: boolean;
  onSelect?: () => void;
  onKill?: () => void;
  /** Desktop-tab only: clicked `.dc` / `.dm` dots. */
  onMinimize?: () => void;
  /** Desktop-tab only: clicked `.dx` dot. */
  onMaximize?: () => void;
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

/** Common payload for /key — small helper so every button reads as 2 lines. */
async function sendKey(sessionId: string, key: string): Promise<void> {
  await authedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

const KEYS_STRIP: ReadonlyArray<{ label: string; key: string; title: string }> = [
  { label: 'ESC', key: 'escape', title: 'Send Escape — close Claude menu' },
  { label: '↑', key: 'up', title: 'Arrow up' },
  { label: '↓', key: 'down', title: 'Arrow down' },
  { label: '←', key: 'left', title: 'Arrow left' },
  { label: '→', key: 'right', title: 'Arrow right' },
  { label: 'Tab', key: 'tab', title: 'Tab (next field / autocomplete)' },
  { label: '^C', key: 'ctrl+c', title: 'Ctrl+C — interrupt' },
];

export function PaneCard({
  session,
  peerSessions,
  active,
  onSelect,
  onKill,
  onMinimize,
  onMaximize,
}: PaneCardProps) {
  const [detail, setDetail] = useState<StatusDetail | null>(null);
  const [promptText, setPromptText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxSources, setCtxSources] = useState<Set<string>>(new Set());
  const [ctxLines, setCtxLines] = useState(40);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueSnapshot, setQueueSnapshot] = useState<{ pending: Array<{ text: string; enqueued_at: string }>; last_drained_at: string | null } | null>(null);
  const [queueDraft, setQueueDraft] = useState('');
  const [handoffTarget, setHandoffTarget] = useState<string>('');
  const [handoffInstr, setHandoffInstr] = useState('');
  const [history, setHistory] = useState<HandoffEntry[] | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await authedFetch(
          `/api/sessions/${encodeURIComponent(session.sessionId)}/status`,
        );
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

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [detail?.lastLines]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

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
      if (!res.ok) setErr(`send failed: HTTP ${res.status}`);
      else setPromptText('');
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setSending(false);
    }
  };

  const handleKill = async (): Promise<void> => {
    // Confirmation via flash — dialogs block the pane-card (and in some
    // Chromium-embedded modes return false silently).
    setFlash(`killing pane ${shortId(session.sessionId)}…`);
    try {
      const res = await authedFetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        setFlash(`kill failed: HTTP ${res.status}`);
        return;
      }
      onKill?.();
    } catch (e2) {
      setFlash(`kill error: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  };

  const handleHandoffSubmit = async (): Promise<void> => {
    if (!handoffTarget || !handoffInstr.trim()) return;
    try {
      const res = await authedFetch('/api/a2a/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_session_id: session.sessionId,
          target_session_id: handoffTarget,
          instruction: handoffInstr.trim(),
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { corr: string };
        setFlash(`↗ handoff ${body.corr} dispatched`);
        setHandoffOpen(false);
        setHandoffInstr('');
      } else {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        setFlash(`handoff failed: ${body.detail ?? res.status}`);
      }
    } catch (e2) {
      setFlash(`handoff error: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  };

  const handleOpenHistory = async (): Promise<void> => {
    setHistoryOpen(true);
    try {
      const res = await authedFetch(
        `/api/handoffs?session=${encodeURIComponent(session.sessionId)}`,
      );
      if (!res.ok) {
        setHistory([]);
        return;
      }
      const body = (await res.json()) as { handoffs: HandoffEntry[] };
      setHistory(body.handoffs);
    } catch {
      setHistory([]);
    }
  };

  const handleOpenQueue = async (): Promise<void> => {
    setQueueOpen(true);
    try {
      const res = await authedFetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}/queue`,
      );
      if (res.ok) setQueueSnapshot(await res.json());
    } catch {
      /* ignore */
    }
  };

  const handleQueueEnqueue = async (): Promise<void> => {
    const text = queueDraft.trim() || promptText.trim();
    if (!text) return;
    try {
      const res = await authedFetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}/queue`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        },
      );
      if (res.ok) {
        const snap = await res.json();
        setQueueSnapshot(snap);
        setQueueDraft('');
        setFlash(`Q+ enqueued (${snap.pending.length} waiting)`);
      } else {
        setFlash(`Q+ failed: HTTP ${res.status}`);
      }
    } catch (e2) {
      setFlash(`Q+ error: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  };

  const handleQueueClear = async (): Promise<void> => {
    try {
      const res = await authedFetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}/queue`,
        { method: 'DELETE' },
      );
      if (res.ok) setQueueSnapshot(await res.json());
    } catch {
      /* ignore */
    }
  };

  const handleQueueAdvanceNext = async (): Promise<void> => {
    try {
      const res = await authedFetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}/queue`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drain: true }),
        },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          drained: { text: string } | null;
          snapshot: {
            pending: Array<{ text: string; enqueued_at: string }>;
            last_drained_at: string | null;
          };
        };
        setQueueSnapshot(body.snapshot);
        setFlash(
          body.drained ? `Q+ drained: ${body.drained.text.slice(0, 40)}` : 'Q+ nothing to drain',
        );
      }
    } catch (e2) {
      setFlash(`Q+ drain error: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  };

  const handleCtxInject = async (): Promise<void> => {
    const ids = Array.from(ctxSources);
    if (ids.length === 0) {
      setFlash('Ctx: pick at least one source pane');
      return;
    }
    try {
      const res = await authedFetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}/inject-context`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_session_ids: ids, lines: ctxLines }),
        },
      );
      if (res.ok) {
        const body = (await res.json()) as { bytes_written: number; sources: unknown[] };
        setFlash(`Ctx injected ${body.sources.length} source(s), ${body.bytes_written}B`);
        setCtxOpen(false);
        setCtxSources(new Set());
      } else {
        setFlash(`Ctx failed: HTTP ${res.status}`);
      }
    } catch (e2) {
      setFlash(`Ctx error: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  };

  const handleAutoHandoff = async (): Promise<void> => {
    if (
      !window.confirm(
        `Handoff & Clear pane ${shortId(session.sessionId)}? This triggers the /handoff skill then /clear.`,
      )
    ) {
      return;
    }
    try {
      const res = await authedFetch(
        `/api/sessions/${encodeURIComponent(session.sessionId)}/auto-handoff`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (res.ok) setFlash('🔄 auto-handoff started');
      else setFlash(`auto-handoff failed: HTTP ${res.status}`);
    } catch (e2) {
      setFlash(`auto-handoff error: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  };

  const status = detail?.status ?? 'idle';
  const statusLabel = status === 'exited' ? 'EXITED' : status.toUpperCase();
  const lines = detail?.lastLines ?? [];
  const name = projectName(session.cwd, session.tabTitle);
  const peers = (peerSessions ?? []).filter((s) => s.sessionId !== session.sessionId);

  return (
    <div className={`dwin ${active ? 'active' : ''}`} onClick={onSelect}>
      <div className="dwin-header">
        <div className="dwin-dots">
          {/* v2.7 parity: dc=minimize, dm=minimize, dx=maximize. Kill via ✕. */}
          <span
            className="dc"
            role="button"
            aria-label="Minimize"
            title="Minimize"
            onClick={(e) => {
              e.stopPropagation();
              onMinimize?.();
            }}
          />
          <span
            className="dm"
            role="button"
            aria-label="Minimize"
            title="Minimize"
            onClick={(e) => {
              e.stopPropagation();
              onMinimize?.();
            }}
          />
          <span
            className="dx"
            role="button"
            aria-label="Maximize"
            title="Maximize / restore"
            onClick={(e) => {
              e.stopPropagation();
              onMaximize?.();
            }}
          />
        </div>
        <span className="dwin-name" title={session.cwd}>
          {name}
        </span>
        <span className="dwin-a2a-slot" aria-label="A2A correlations" />
        <span
          className={`dwin-st ${status}`}
          title={`status: ${status}${detail?.exitCode !== null && detail?.exitCode !== undefined ? ` (exit ${detail.exitCode})` : ''}`}
        >
          {statusLabel}
        </span>
        {detail?.ctxPercent != null && (
          <span
            className={`ctx-badge ctx-${ctxTier(detail.ctxPercent)}`}
            title={`context budget used: ${detail.ctxPercent.toFixed(1)}%`}
          >
            {Math.round(detail.ctxPercent)}%
          </span>
        )}
        {session.persona && (
          <span className="dwin-persona" title={`persona: ${session.persona}`}>
            {session.persona}
          </span>
        )}
        <button
          type="button"
          className="dwin-btn handoff-btn"
          onClick={(e) => {
            e.stopPropagation();
            setHandoffOpen((v) => !v);
          }}
          title="Handoff to another pane"
          aria-label="Open handoff picker"
        >
          ↗
        </button>
        <button
          type="button"
          className="dwin-btn handoff-history-btn"
          onClick={(e) => {
            e.stopPropagation();
            void handleOpenHistory();
          }}
          title="Handoff history"
          aria-label="Open handoff history"
        >
          📜
        </button>
        <button
          type="button"
          className="dwin-btn auto-handoff-btn"
          onClick={(e) => {
            e.stopPropagation();
            void handleAutoHandoff();
          }}
          title="Handoff & Clear (auto-handoff)"
          aria-label="Auto-handoff (handoff + clear)"
        >
          🔄
        </button>
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

      {handoffOpen && (
        <div
          className="dwin-handoff-popover"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Handoff picker"
        >
          <div className="dwin-handoff-title">Handoff from {name} to…</div>
          <select
            aria-label="Handoff target"
            value={handoffTarget}
            onChange={(e) => setHandoffTarget(e.target.value)}
          >
            <option value="">— pick target pane —</option>
            {peers.map((p) => (
              <option key={p.sessionId} value={p.sessionId}>
                {projectName(p.cwd, p.tabTitle)} ({shortId(p.sessionId)})
              </option>
            ))}
          </select>
          <textarea
            aria-label="Handoff instruction"
            placeholder="Instruction for the target pane…"
            value={handoffInstr}
            onChange={(e) => setHandoffInstr(e.target.value)}
            rows={3}
          />
          <div className="dwin-handoff-actions">
            <button
              type="button"
              onClick={() => setHandoffOpen(false)}
              className="dwin-btn"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleHandoffSubmit()}
              disabled={!handoffTarget || !handoffInstr.trim()}
              className="dwin-btn dwin-btn-primary"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {historyOpen && (
        <div
          className="dwin-history-popover"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Handoff history"
        >
          <div className="dwin-handoff-title">Handoffs in {name}/handoffs/</div>
          {history === null && <div className="dwin-history-empty">loading…</div>}
          {history !== null && history.length === 0 && (
            <div className="dwin-history-empty">(no handoffs found)</div>
          )}
          {history !== null &&
            history.map((h) => (
              <div
                className="dwin-history-entry"
                key={h.filename}
                role="button"
                tabIndex={0}
                title="Click to copy absolute path"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(h.filepath)
                    .then(() => setFlash(`path copied: ${h.filename}`))
                    .catch(() => setFlash('clipboard unavailable'));
                }}
              >
                <div className="dwin-history-filename">{h.filename}</div>
                <div className="dwin-history-meta">
                  {h.sent ?? h.mtime ?? '?'}
                  {h.corr ? ` · corr=${h.corr}` : ''} · {h.size}B
                </div>
              </div>
            ))}
          <div className="dwin-handoff-actions">
            <button
              type="button"
              onClick={() => setHistoryOpen(false)}
              className="dwin-btn"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {queueOpen && (
        <div
          className="dwin-handoff-popover"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Queue"
        >
          <div className="dwin-handoff-title">Queue for {name}</div>
          {queueSnapshot?.last_drained_at && (
            <div className="dwin-history-meta">last drained: {queueSnapshot.last_drained_at}</div>
          )}
          {queueSnapshot === null && <div className="dwin-history-empty">loading…</div>}
          {queueSnapshot !== null && queueSnapshot.pending.length === 0 && (
            <div className="dwin-history-empty">(queue empty)</div>
          )}
          {queueSnapshot?.pending.map((e, i) => (
            <div className="dwin-history-entry" key={`${e.enqueued_at}-${i}`}>
              <div className="dwin-history-filename">#{i + 1}: {e.text}</div>
              <div className="dwin-history-meta">enqueued {e.enqueued_at}</div>
            </div>
          ))}
          <textarea
            aria-label="Queue new prompt"
            placeholder="New queued prompt…"
            value={queueDraft}
            onChange={(e) => setQueueDraft(e.target.value)}
            rows={2}
          />
          <div className="dwin-handoff-actions">
            <button type="button" className="dwin-btn" onClick={() => setQueueOpen(false)}>
              Close
            </button>
            <button type="button" className="dwin-btn" onClick={() => void handleQueueClear()}>
              Clear
            </button>
            <button
              type="button"
              className="dwin-btn"
              disabled={!queueSnapshot || queueSnapshot.pending.length === 0}
              onClick={() => void handleQueueAdvanceNext()}
              title="Drain the head entry now (normally fires on pane_idle)"
            >
              Advance ▶
            </button>
            <button
              type="button"
              className="dwin-btn dwin-btn-primary"
              disabled={!queueDraft.trim() && !promptText.trim()}
              onClick={() => void handleQueueEnqueue()}
            >
              Enqueue
            </button>
          </div>
        </div>
      )}

      {ctxOpen && (
        <div
          className="dwin-handoff-popover"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Inject context"
        >
          <div className="dwin-handoff-title">Inject context into {name}</div>
          {peers.length === 0 && (
            <div className="dwin-history-empty">(no other panes to source from)</div>
          )}
          {peers.map((p) => {
            const checked = ctxSources.has(p.sessionId);
            return (
              <label className="dwin-ctx-peer" key={p.sessionId}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const next = new Set(ctxSources);
                    if (e.target.checked) next.add(p.sessionId);
                    else next.delete(p.sessionId);
                    setCtxSources(next);
                  }}
                />{' '}
                {projectName(p.cwd, p.tabTitle)} ({shortId(p.sessionId)})
              </label>
            );
          })}
          <label className="dwin-ctx-lines">
            Last{' '}
            <input
              type="number"
              min={5}
              max={200}
              value={ctxLines}
              onChange={(e) => setCtxLines(Number(e.target.value) || 40)}
              aria-label="Lines per source"
            />{' '}
            rendered lines per source
          </label>
          <div className="dwin-handoff-actions">
            <button type="button" className="dwin-btn" onClick={() => setCtxOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="dwin-btn dwin-btn-primary"
              disabled={ctxSources.size === 0}
              onClick={() => void handleCtxInject()}
            >
              Inject
            </button>
          </div>
        </div>
      )}

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

      <div
        className="dwin-keys"
        role="group"
        aria-label="Special keys"
        onClick={(e) => e.stopPropagation()}
      >
        {KEYS_STRIP.map((k) => (
          <button
            key={k.key}
            type="button"
            className="dwin-key-btn"
            title={k.title}
            aria-label={k.title}
            onClick={() => void sendKey(session.sessionId, k.key)}
          >
            {k.label}
          </button>
        ))}
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
        <button
          type="button"
          className="dwin-btn dwin-btn-q"
          title="Add prompt to queue — drains on pane_idle"
          aria-label="Queue prompt"
          onClick={() => void handleOpenQueue()}
        >
          Q+
        </button>
        <button
          type="button"
          className="dwin-btn dwin-btn-ctx"
          title="Inject context from peer panes"
          aria-label="Inject context"
          onClick={() => setCtxOpen((v) => !v)}
        >
          Ctx
        </button>
        <button
          type="button"
          className="dwin-btn dwin-btn-mode"
          title="Toggle permission mode (Alt+M)"
          aria-label="Toggle permission mode"
          onClick={() => void sendKey(session.sessionId, 'alt+m')}
        >
          Mode
        </button>
      </form>

      {flash && <div className="dwin-flash">{flash}</div>}
      {err && <div className="dwin-err">{err}</div>}

      <div className="dwin-meta">
        <span className="dwin-meta-item" title="session id">
          {shortId(session.sessionId)}
        </span>
        <span className="dwin-meta-item" title="cli">
          {session.cli}
        </span>
      </div>
    </div>
  );
}
