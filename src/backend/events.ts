/**
 * SSE event bus — single source of truth for cross-pane events consumed by the
 * dashboard and omniclaude. Per ADR-003 (addendum).
 *
 * Phase 3 scope: the EventBus core + SSE transport. Individual event emitters
 * live in `src/backend/event-emitters/*` and publish via `bus.publish(evt)`.
 */

import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

import type { SseEvent } from '../shared/types.js';

/**
 * Distributive Omit — applies Omit independently to each member of a
 * discriminated union, preserving the per-variant fields that survive.
 * Without this, `Omit<SseEvent, 'id' | 'ts'>` collapses the union to its
 * common fields and drops variant-specific ones like `taskId` or `crossed`.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type SsePublishInput = DistributiveOmit<SseEvent, 'id' | 'ts'> & {
  id?: number;
  ts?: string;
};

export class EventBus extends EventEmitter {
  private nextId = 1;

  /** Publish an event. Fills `id` + `ts` if absent. */
  publish(evt: SsePublishInput): SseEvent {
    const full = {
      id: evt.id ?? this.nextId++,
      ts: evt.ts ?? new Date().toISOString(),
      ...evt,
    } as SseEvent;
    this.emit('event', full);
    return full;
  }

  subscribe(listener: (evt: SseEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

/**
 * Write the SSE response headers and return a helper that pushes events down
 * the wire. The caller is responsible for closing the response when the
 * client disconnects.
 */
export function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  // Flush headers immediately so the client gets a fast handshake.
  res.write(': sse stream open\n\n');
}

export function writeSseEvent(res: ServerResponse, evt: SseEvent): void {
  res.write(`id: ${evt.id}\n`);
  res.write(`event: ${evt.type}\n`);
  res.write(`data: ${JSON.stringify(evt)}\n\n`);
}
