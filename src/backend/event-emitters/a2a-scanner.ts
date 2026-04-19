/**
 * A2A envelope scanner — watches raw PTY data for `[A2A ...]` headers and
 * publishes two SSE event types onto the EventBus:
 *
 *   - `a2a_received`  : every newly-observed envelope header.
 *   - `peer_orphaned` : when a pane exits while one or more of its
 *                       correlations are still open, the surviving peer is
 *                       notified so it can stop waiting.
 *
 * The accumulator per session is a bounded ring of the last ~8KB of text; we
 * rescan the whole window on every PTY chunk because a header may straddle
 * chunk boundaries. Dedup uses the absolute character offset (cumulative
 * across truncations) so stable keys survive the ring sliding forward.
 *
 * Correlation semantics mirror `src/omni-watcher.cjs` (v2.x):
 *   - `request`            : open a correlation entry keyed by `corr`.
 *   - `ack` | `progress`   : no state change (correlation stays open).
 *   - `result` | `error`   : close the correlation (delete the entry).
 *
 * See `docs/a2a-protocol.md` for the envelope format.
 */

import type { PtyManager, PtyDataEvent, PtyExitEvent } from '../pty-manager.js';
import type { EventBus } from '../events.js';
import type { SessionId, SseEvent } from '../../shared/types.js';

type EnvelopeType = 'request' | 'ack' | 'progress' | 'result' | 'error';

type PayloadOf<T extends SseEvent['type']> = Omit<Extract<SseEvent, { type: T }>, 'id' | 'ts'>;

interface Accumulator {
  /** Last ~8KB of raw PTY text, oldest first. */
  text: string;
  /** Cumulative count of characters ever appended (pre-truncation). */
  totalChars: number;
  /** Dedup keys for envelopes we've already emitted on this session. */
  seen: Set<string>;
}

interface OpenCorr {
  from: string;
  to: string;
  openedAt: number;
  /** Session where the request envelope was first observed. */
  sessionId: SessionId;
}

const MAX_ACCUMULATOR_CHARS = 8192;

/**
 * Matches an A2A envelope header. The trailing `[^\]]*` absorbs optional
 * fields like `| reason=...` (v2.7 error envelopes) or `| owns=...` without
 * needing to enumerate them explicitly.
 *
 * `from` / `to` accept both numeric (v2.x) and UUID (v3.0) pane ids via
 * `[A-Za-z0-9\-_]+`.
 */
const ENVELOPE_RE =
  /\[A2A from pane-([A-Za-z0-9\-_]+) to pane-([A-Za-z0-9\-_]+) \| corr=([^|\s]+) \| type=(request|ack|progress|result|error)[^\]]*\]/g;

export function attachA2aScanner(manager: PtyManager, bus: EventBus): () => void {
  const accumulators = new Map<SessionId, Accumulator>();
  const openCorr = new Map<string, OpenCorr>();

  const onData = (evt: PtyDataEvent): void => {
    const acc = getOrCreateAccumulator(accumulators, evt.sessionId);
    appendChunk(acc, evt.data);
    scanAccumulator(acc, evt.sessionId, bus, openCorr);
  };

  const onExit = (evt: PtyExitEvent): void => {
    handleExit(evt.sessionId, manager, bus, openCorr);
    accumulators.delete(evt.sessionId);
  };

  manager.on('data', onData);
  manager.on('exit', onExit);

  return (): void => {
    manager.off('data', onData);
    manager.off('exit', onExit);
    accumulators.clear();
    openCorr.clear();
  };
}

function getOrCreateAccumulator(
  map: Map<SessionId, Accumulator>,
  sessionId: SessionId,
): Accumulator {
  let acc = map.get(sessionId);
  if (!acc) {
    acc = { text: '', totalChars: 0, seen: new Set<string>() };
    map.set(sessionId, acc);
  }
  return acc;
}

function appendChunk(acc: Accumulator, chunk: string): void {
  acc.text += chunk;
  acc.totalChars += chunk.length;
  if (acc.text.length > MAX_ACCUMULATOR_CHARS) {
    // Truncate oldest characters; dedup keys are based on cumulative offset
    // so the shift does not invalidate them.
    acc.text = acc.text.slice(acc.text.length - MAX_ACCUMULATOR_CHARS);
  }
}

/**
 * Absolute character offset (in the cumulative PTY stream) of the first
 * character currently held in the accumulator window.
 */
function baseOffset(acc: Accumulator): number {
  return acc.totalChars - acc.text.length;
}

function scanAccumulator(
  acc: Accumulator,
  sessionId: SessionId,
  bus: EventBus,
  openCorr: Map<string, OpenCorr>,
): void {
  // Fresh regex per scan — the global `g` flag keeps `lastIndex` state that
  // would otherwise leak across chunks.
  const re = new RegExp(ENVELOPE_RE.source, 'g');
  let match: RegExpExecArray | null;
  const base = baseOffset(acc);
  while ((match = re.exec(acc.text)) !== null) {
    const from = match[1];
    const to = match[2];
    const corr = match[3];
    const envelopeType = match[4] as EnvelopeType;
    if (!from || !to || !corr || !envelopeType) continue;

    const absIndex = base + match.index;
    const dedupKey = `${from}|${to}|${corr}|${envelopeType}|${absIndex}`;
    if (acc.seen.has(dedupKey)) continue;
    acc.seen.add(dedupKey);

    const payload: PayloadOf<'a2a_received'> = {
      type: 'a2a_received',
      sessionId,
      from,
      to,
      corr,
      envelopeType,
    };
    bus.publish(payload);

    updateOpenCorr(openCorr, corr, from, to, envelopeType, sessionId);
  }
}

function updateOpenCorr(
  openCorr: Map<string, OpenCorr>,
  corr: string,
  from: string,
  to: string,
  envelopeType: EnvelopeType,
  sessionId: SessionId,
): void {
  if (envelopeType === 'result' || envelopeType === 'error') {
    openCorr.delete(corr);
    return;
  }
  if (envelopeType === 'request') {
    if (!openCorr.has(corr)) {
      openCorr.set(corr, { from, to, openedAt: Date.now(), sessionId });
    }
    return;
  }
  // ack | progress — no state change (correlation stays open).
}

function handleExit(
  deadSessionId: SessionId,
  manager: PtyManager,
  bus: EventBus,
  openCorr: Map<string, OpenCorr>,
): void {
  const toClose: string[] = [];
  for (const [corrId, info] of openCorr) {
    const deadIsFrom = info.from === deadSessionId;
    const deadIsTo = info.to === deadSessionId;
    if (!deadIsFrom && !deadIsTo) continue;

    const survivorId: SessionId = deadIsFrom ? info.to : info.from;
    // Only emit if the survivor is still a live session on this manager.
    if (manager.get(survivorId)) {
      const payload: PayloadOf<'peer_orphaned'> = {
        type: 'peer_orphaned',
        sessionId: survivorId,
        deadPeer: deadSessionId,
        corr: corrId,
      };
      bus.publish(payload);
    }
    toClose.push(corrId);
  }
  for (const corrId of toClose) {
    openCorr.delete(corrId);
  }
}
