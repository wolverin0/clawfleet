import { useEffect, useRef, useState } from 'react';
import { authedFetch } from '../auth';

/**
 * U3 panel — OmniClaude: the user ↔ orchestrator chat surface. Same shape
 * the standalone ChatPanel had, but lives inside the activity sidebar now.
 *
 * Polls /api/chat/messages every 3s; unresolved orchestrator asks render
 * with an inline reply input; the bottom input is user-initiated messages.
 */

interface ChatMessage {
  id: string;
  ts: string;
  from: 'orchestrator' | 'user';
  sessionId: string | null;
  topic: string;
  text: string;
  inReplyTo?: string;
  resolvedAt?: string;
  /** PLAN-OF-TRUTH P4.3 — dashboard snapshot attached at ask time. */
  snapshot?: {
    capturedAt: string;
    latencyMs: number;
    refsCount: number;
    error?: string;
  };
}

type Status = 'loading' | 'ok' | 'not_ready' | 'error';

const POLL_INTERVAL_MS = 3000;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function OmniClaudePanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const cancelledRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    cancelledRef.current = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await authedFetch('/api/chat/messages?limit=100');
        if (res.status === 503) {
          if (!cancelledRef.current) setStatus('not_ready');
          return;
        }
        if (!res.ok) {
          if (!cancelledRef.current) setStatus('error');
          return;
        }
        const body = (await res.json()) as { messages: ChatMessage[] };
        if (cancelledRef.current) return;
        setMessages(body.messages);
        setStatus('ok');
      } catch {
        if (!cancelledRef.current) setStatus('error');
      }
    };
    void poll();
    const handle = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(handle);
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleReply = async (askId: string): Promise<void> => {
    const draft = (replyDrafts[askId] ?? '').trim();
    if (!draft || sending) return;
    setSending(true);
    try {
      await authedFetch('/api/chat/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ in_reply_to: askId, text: draft }),
      });
      setReplyDrafts((prev) => ({ ...prev, [askId]: '' }));
    } finally {
      setSending(false);
    }
  };

  const handleSend = async (): Promise<void> => {
    const text = newMessage.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await authedFetch('/api/chat/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      setNewMessage('');
    } finally {
      setSending(false);
    }
  };

  if (status === 'not_ready') {
    return <div className="as-empty">Orchestrator not attached yet.</div>;
  }

  return (
    <div className="omni-panel">
      <div className="omni-list" ref={listRef}>
        {messages.length === 0 && <div className="as-empty">No messages yet.</div>}
        {messages.map((m) => {
          const isOrch = m.from === 'orchestrator';
          const isUnresolved = isOrch && !m.resolvedAt;
          return (
            <div key={m.id} className={`omni-msg ${isOrch ? 'orch' : 'user'}${isUnresolved ? ' unresolved' : ''}`}>
              <div className="omni-msg-head">
                <span className="omni-msg-topic">{m.topic}</span>
                <span className="omni-msg-time">{fmtTime(m.ts)}</span>
              </div>
              <div className="omni-msg-body">{m.text}</div>
              {m.snapshot && (
                <div className={`omni-msg-snap ${m.snapshot.error ? 'err' : ''}`}>
                  {m.snapshot.error
                    ? `snapshot: ${m.snapshot.error.slice(0, 60)}`
                    : `📸 snapshot · ${m.snapshot.refsCount} refs · ${m.snapshot.latencyMs}ms`}
                </div>
              )}
              {isUnresolved && (
                <div className="omni-msg-reply">
                  <input
                    type="text"
                    placeholder="Reply…"
                    value={replyDrafts[m.id] ?? ''}
                    onChange={(e) =>
                      setReplyDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleReply(m.id);
                      }
                    }}
                    aria-label={`Reply to ${m.topic}`}
                  />
                  <button
                    type="button"
                    onClick={() => void handleReply(m.id)}
                    disabled={!(replyDrafts[m.id] ?? '').trim() || sending}
                  >
                    Reply
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="omni-compose">
        <input
          type="text"
          placeholder="Type a message…"
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleSend();
            }
          }}
          aria-label="New message to orchestrator"
        />
        <button type="button" onClick={() => void handleSend()} disabled={!newMessage.trim() || sending}>
          Send
        </button>
      </div>
    </div>
  );
}
