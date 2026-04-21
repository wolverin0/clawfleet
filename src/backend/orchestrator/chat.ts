/**
 * Dashboard chat panel — the user ↔ orchestrator bidirectional channel for
 * content-class decisions the orchestrator refuses to handle autonomously.
 *
 * Phase 7 scope: in-memory message store with simple ask/answer/resolve
 * semantics. Phase 8 wires Telegram push notifications on top so the user
 * gets pinged when an `ask` lands; Phase 9 adds auth.
 *
 * 2026-04-21: each orchestrator-originated ask now attaches a dashboard
 * snapshot (agent-browser a11y tree of the running dashboard) asynchronously.
 * The snapshot lands on the message in-place; dashboard + LLM consumers see
 * it on the next /api/chat/messages poll.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type { SessionId } from '../../shared/types.js';
import type { EventBus } from '../events.js';
import type { TelegramPusher } from '../telegram-push.js';
import type { DashboardSnapshotPayload } from './dashboard-controller.js';

export interface ChatMessage {
  id: string;
  ts: string;
  /** Who sent it. `orchestrator` = omniclaude asking; `user` = user answering. */
  from: 'orchestrator' | 'user';
  /** Related pane, if any (e.g. the pane that triggered the escalation). */
  sessionId: SessionId | null;
  /** Short category (merge, design, critical, generic) for future filtering. */
  topic: string;
  /** The message body. */
  text: string;
  /** Reply-to: on user answers, which orchestrator ask this resolves. */
  inReplyTo?: string;
  /** Set when the orchestrator considers this ask resolved. */
  resolvedAt?: string;
  /**
   * Dashboard snapshot (a11y tree + semantic refs) captured at ask-time.
   * Attached asynchronously — `undefined` immediately after ask(), then
   * filled in once agent-browser returns. `error` is set if the snapshot
   * failed; `refsCount === 0` + `error === undefined` = not-yet-attached.
   */
  snapshot?: DashboardSnapshotPayload;
}

/** Provider the chat uses to fetch a dashboard snapshot when an ask lands. */
export type SnapshotProvider = () => Promise<DashboardSnapshotPayload>;

export interface ChatStoreEvents {
  'chat_updated': [ChatMessage];
}

export class ChatStore extends EventEmitter {
  private readonly messages: ChatMessage[] = [];
  private readonly maxMessages = 500;

  constructor(
    private readonly bus?: EventBus,
    private readonly telegram?: TelegramPusher,
    private readonly snapshotProvider?: SnapshotProvider,
  ) {
    super();
  }

  list(): ChatMessage[] {
    return [...this.messages];
  }

  latest(n: number): ChatMessage[] {
    return this.messages.slice(Math.max(0, this.messages.length - n));
  }

  /** Orchestrator posts a question. Returns the new message. */
  ask(sessionId: SessionId | null, topic: string, text: string): ChatMessage {
    const msg: ChatMessage = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      from: 'orchestrator',
      sessionId,
      topic,
      text,
    };
    this.push(msg);
    // Phase 8 — push notification. Fire-and-forget; never block ask().
    if (this.telegram) {
      try {
        this.telegram.notify(`[${topic}] orchestrator`, text);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[chat] telegram notify threw: ${m}\n`);
      }
    }
    // 2026-04-21 — attach dashboard snapshot async. Does NOT block ask().
    if (this.snapshotProvider) {
      this.snapshotProvider()
        .then((snap) => {
          msg.snapshot = snap;
          this.emit('chat_updated', msg);
        })
        .catch((err) => {
          const m = err instanceof Error ? err.message : String(err);
          msg.snapshot = {
            capturedAt: new Date().toISOString(),
            latencyMs: 0,
            refsCount: 0,
            refs: {},
            snapshotText: null,
            error: m.slice(0, 500),
          };
          this.emit('chat_updated', msg);
        });
    }
    return msg;
  }

  /** User answers an existing ask. */
  answer(inReplyTo: string, text: string): ChatMessage {
    const ask = this.messages.find((m) => m.id === inReplyTo);
    const topic = ask?.topic ?? 'generic';
    const sessionId = ask?.sessionId ?? null;
    const msg: ChatMessage = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      from: 'user',
      sessionId,
      topic,
      text,
      inReplyTo,
    };
    this.push(msg);
    // Mark the ask as resolved.
    if (ask) {
      ask.resolvedAt = msg.ts;
      this.emit('chat_updated', ask);
    }
    return msg;
  }

  /** User-initiated message (not a reply). Treated as a direct statement. */
  userMessage(text: string): ChatMessage {
    const msg: ChatMessage = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      from: 'user',
      sessionId: null,
      topic: 'generic',
      text,
    };
    this.push(msg);
    return msg;
  }

  private push(msg: ChatMessage): void {
    this.messages.push(msg);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }
    this.emit('chat_updated', msg);
    void this.bus;
  }
}
