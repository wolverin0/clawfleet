/**
 * Auto-handoff watchdog.
 *
 * Subscribes to the SSE event bus and, when a pane crosses ctx_threshold=70,
 * invokes `runAutoHandoff` automatically. The auto-handoff flow already
 * asks the pane a READINESS CHECK first (see src/backend/auto-handoff.ts
 * lines 175-198), so this is safe: if the pane says NOT_READY, the flow
 * returns `{status:'not_ready'}` and the pane keeps working. If READY, the
 * /handoff skill runs, the file is written, and /clear resets the session.
 *
 * Cooldown: 15 min per session to avoid re-firing on a single sustained
 * 70%+ stretch if the readiness check replies NOT_READY and the pane keeps
 * climbing.
 */

import { runAutoHandoff } from './auto-handoff.js';
import type { EventBus } from './events.js';
import type { PtyManager } from './pty-manager.js';
import type { SessionId } from '../shared/types.js';

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

interface WatchdogOptions {
  cooldownMs?: number;
  enabled?: boolean;
}

export function attachAutoHandoffWatchdog(
  manager: PtyManager,
  bus: EventBus,
  opts: WatchdogOptions = {},
): () => void {
  if (opts.enabled === false) return () => {};
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const lastFired = new Map<SessionId, number>();

  const unsubscribe = bus.subscribe((evt) => {
    if (evt.type !== 'ctx_threshold') return;
    if (evt.crossed !== 70) return;
    const now = Date.now();
    const last = lastFired.get(evt.sessionId) ?? 0;
    if (now - last < cooldownMs) return;
    lastFired.set(evt.sessionId, now);

    // Fire and forget. runAutoHandoff asks READINESS CHECK first, so this
    // won't force a handoff over mid-task work.
    console.error(
      `[auto-handoff-watchdog] pane ${evt.sessionId.slice(0, 8)} at ${evt.percent}% — invoking auto-handoff`,
    );
    void runAutoHandoff(manager, bus, evt.sessionId, {
      focus: `automatic ctx=${Math.round(evt.percent)}% threshold`,
    }).then((result) => {
      console.error(
        `[auto-handoff-watchdog] pane ${evt.sessionId.slice(0, 8)} result=${result.status}` +
          ('reason' in result && result.reason ? ` reason=${result.reason.slice(0, 60)}` : ''),
      );
    });
  });

  return unsubscribe;
}
