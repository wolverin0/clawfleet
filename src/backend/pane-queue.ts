/**
 * Per-pane prompt queue. When the user clicks `Q+` on a pane-card, the
 * typed text is pushed here. The queue drains one entry per `pane_idle`
 * SSE event — i.e. the next prompt is sent only when the previous one
 * has finished. Mirrors the v2.7 `addToQueue()` contract.
 */

import type { PtyManager } from './pty-manager.js';
import type { EventBus } from './events.js';
import type { SessionId } from '../shared/types.js';

export interface QueuedEntry {
  text: string;
  enqueued_at: string;
}

export interface QueueSnapshot {
  session_id: SessionId;
  pending: QueuedEntry[];
  last_drained_at: string | null;
}

export class PaneQueueStore {
  private readonly queues = new Map<SessionId, QueuedEntry[]>();
  private readonly lastDrain = new Map<SessionId, string>();
  private unsubscribe: (() => void) | null = null;

  /** Push text onto the tail of the session's queue. */
  enqueue(sessionId: SessionId, text: string): QueueSnapshot {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('text is required');
    const existing = this.queues.get(sessionId) ?? [];
    existing.push({ text: trimmed, enqueued_at: new Date().toISOString() });
    this.queues.set(sessionId, existing);
    return this.snapshot(sessionId);
  }

  /**
   * Push text onto the HEAD of the session's queue — for high-priority
   * entries (e.g. user missions via tell-omni) that must jump the line ahead
   * of event-driven noise like `pane_idle` no_ops. Normal event prompts use
   * enqueue(); user-authored missions use enqueueFront() so they aren't
   * starved behind a backlog.
   */
  enqueueFront(sessionId: SessionId, text: string): QueueSnapshot {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('text is required');
    const existing = this.queues.get(sessionId) ?? [];
    existing.unshift({ text: trimmed, enqueued_at: new Date().toISOString() });
    this.queues.set(sessionId, existing);
    return this.snapshot(sessionId);
  }

  snapshot(sessionId: SessionId): QueueSnapshot {
    return {
      session_id: sessionId,
      pending: [...(this.queues.get(sessionId) ?? [])],
      last_drained_at: this.lastDrain.get(sessionId) ?? null,
    };
  }

  clear(sessionId: SessionId): QueueSnapshot {
    this.queues.delete(sessionId);
    return this.snapshot(sessionId);
  }

  /**
   * Subscribe to the bus and drain one entry per `pane_idle` event.
   * Returns a disposer so tests + shutdown can unwire.
   */
  attach(bus: EventBus, manager: PtyManager): () => void {
    this.unsubscribe = bus.subscribe((evt) => {
      if (evt.type !== 'pane_idle') return;
      const queue = this.queues.get(evt.sessionId);
      if (!queue || queue.length === 0) return;
      const next = queue.shift();
      if (!next) return;
      try {
        void manager.writeAndSubmit(evt.sessionId, next.text);
        this.lastDrain.set(evt.sessionId, new Date().toISOString());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[pane-queue] drain failed for ${evt.sessionId}: ${msg}`);
        // Re-push at the head so the text is not lost if pane came back.
        queue.unshift(next);
      }
      if (queue.length === 0) this.queues.delete(evt.sessionId);
    });
    return (): void => this.detach();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Force-drain the head entry. Exposed for tests + the HTTP "drain now"
   * endpoint; normal operation waits for a pane_idle event.
   */
  drainOne(manager: PtyManager, sessionId: SessionId): QueuedEntry | null {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return null;
    const next = queue.shift()!;
    void manager.writeAndSubmit(sessionId, next.text);
    this.lastDrain.set(sessionId, new Date().toISOString());
    if (queue.length === 0) this.queues.delete(sessionId);
    return next;
  }
}
