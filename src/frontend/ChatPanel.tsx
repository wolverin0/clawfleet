import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Phase 8 — chat panel. Polls /api/chat/messages every 3s and renders the
 * orchestrator ↔ user thread. Mirrors the ChatMessage shape from
 * src/backend/orchestrator/chat.ts; we keep a local copy to avoid pulling
 * backend code into the frontend tsconfig.
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
}

type PanelStatus =
  | { kind: 'loading' }
  | { kind: 'ok' }
  | { kind: 'not_ready' }
  | { kind: 'error'; message: string };

const POLL_INTERVAL_MS = 3000;
const TOKEN_STORAGE_KEY = 'theorchestra.token';

function authHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<PanelStatus>({ kind: 'loading' });
  const [newMessage, setNewMessage] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  const cancelledRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const fetchMessages = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/chat/messages?limit=100', {
        headers: authHeaders(),
      });
      if (res.status === 503) {
        if (!cancelledRef.current) setStatus({ kind: 'not_ready' });
        return;
      }
      if (!res.ok) {
        if (!cancelledRef.current) {
          setStatus({ kind: 'error', message: `GET /api/chat/messages ${res.status}` });
        }
        return;
      }
      const body = (await res.json()) as { messages?: ChatMessage[] };
      if (cancelledRef.current) return;
      setMessages(Array.isArray(body.messages) ? body.messages : []);
      setStatus({ kind: 'ok' });
    } catch (err) {
      if (cancelledRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', message });
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void fetchMessages();
    const timer = window.setInterval(() => {
      void fetchMessages();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(timer);
    };
  }, [fetchMessages]);

  // Auto-scroll to bottom when a new message arrives.
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : '';
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lastMessageId]);

  const orderedMessages = useMemo(() => {
    return [...messages].sort((a, b) => a.ts.localeCompare(b.ts));
  }, [messages]);

  const postJson = useCallback(
    async (path: string, body: unknown): Promise<boolean> => {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) return false;
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const handleSendNew = useCallback(async () => {
    const text = newMessage.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    const ok = await postJson('/api/chat/ask', { text });
    setSending(false);
    if (ok) {
      setNewMessage('');
      void fetchMessages();
    }
  }, [newMessage, sending, postJson, fetchMessages]);

  const handleReply = useCallback(
    async (msgId: string) => {
      const text = (replyDrafts[msgId] ?? '').trim();
      if (text.length === 0 || sending) return;
      setSending(true);
      const ok = await postJson('/api/chat/answer', { in_reply_to: msgId, text });
      setSending(false);
      if (ok) {
        setReplyDrafts((prev) => {
          const next = { ...prev };
          delete next[msgId];
          return next;
        });
        void fetchMessages();
      }
    },
    [replyDrafts, sending, postJson, fetchMessages],
  );

  if (status.kind === 'not_ready') {
    return (
      <div className="chat-panel">
        <div className="chat-header">Orchestrator chat</div>
        <div className="chat-empty">Orchestrator not ready yet</div>
      </div>
    );
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">Orchestrator chat</div>
      <div className="chat-messages" ref={listRef}>
        {status.kind === 'loading' && orderedMessages.length === 0 ? (
          <div className="chat-empty">Loading…</div>
        ) : null}
        {status.kind === 'error' ? (
          <div className="chat-error">Error: {status.message}</div>
        ) : null}
        {status.kind === 'ok' && orderedMessages.length === 0 ? (
          <div className="chat-empty">No messages yet</div>
        ) : null}
        {orderedMessages.map((msg) => (
          <ChatBubble
            key={msg.id}
            msg={msg}
            replyDraft={replyDrafts[msg.id] ?? ''}
            onReplyChange={(v) => setReplyDrafts((prev) => ({ ...prev, [msg.id]: v }))}
            onReplySubmit={() => {
              void handleReply(msg.id);
            }}
            sending={sending}
          />
        ))}
      </div>
      <div className="chat-compose">
        <textarea
          className="chat-input"
          placeholder="Type a message…"
          rows={2}
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSendNew();
            }
          }}
          disabled={sending}
        />
        <button
          type="button"
          className="chat-send"
          onClick={() => {
            void handleSendNew();
          }}
          disabled={sending || newMessage.trim().length === 0}
        >
          Send
        </button>
      </div>
    </div>
  );
}

interface ChatBubbleProps {
  msg: ChatMessage;
  replyDraft: string;
  onReplyChange: (v: string) => void;
  onReplySubmit: () => void;
  sending: boolean;
}

function ChatBubble({ msg, replyDraft, onReplyChange, onReplySubmit, sending }: ChatBubbleProps) {
  const isOrch = msg.from === 'orchestrator';
  const isUnresolved = isOrch && !msg.resolvedAt;
  const bubbleClass = [
    'chat-bubble',
    isOrch ? 'chat-bubble-orch' : 'chat-bubble-user',
    isUnresolved ? 'chat-bubble-unresolved' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`chat-row chat-row-${msg.from}`}>
      <div className={bubbleClass}>
        <div className="chat-meta">
          {isOrch ? (
            <span className="chat-topic">{msg.topic}</span>
          ) : (
            <span className="chat-topic chat-topic-user">you</span>
          )}
          <span className="chat-ts">{formatTs(msg.ts)}</span>
        </div>
        <div className="chat-text">{msg.text}</div>
        {isUnresolved ? (
          <div className="chat-reply">
            <input
              className="chat-reply-input"
              type="text"
              placeholder="Reply…"
              value={replyDraft}
              onChange={(e) => onReplyChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onReplySubmit();
                }
              }}
              disabled={sending}
            />
            <button
              type="button"
              className="chat-reply-button"
              onClick={onReplySubmit}
              disabled={sending || replyDraft.trim().length === 0}
            >
              Reply
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatTs(ts: string): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleTimeString();
  } catch {
    return ts;
  }
}
