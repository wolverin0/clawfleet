/**
 * status-bar emitter — scans the rendered xterm-headless buffer of each pane on
 * data arrival and emits three SSE event types:
 *
 *   - `pane_idle`         : fires on a working -> idle transition.
 *   - `ctx_threshold`     : fires when Ctx: NN.N% crosses 30 or 50 (upward).
 *   - `permission_prompt` : fires when Claude Code renders a permission prompt.
 *
 * Port of v2.x `src/omni-watcher.cjs` heuristics onto the v3.0 deterministic
 * xterm-headless rendering. Because the buffer is already parsed, the regexes
 * are simpler and more reliable than polling `wezterm cli get-text`.
 */

import type { PtyDataEvent, PtyExitEvent, PtyManager } from '../pty-manager.js';
import type { EventBus } from '../events.js';
import type { SessionId, SseEvent } from '../../shared/types.js';

type PayloadOf<T extends SseEvent['type']> = Omit<Extract<SseEvent, { type: T }>, 'id' | 'ts'>;

/** Debounce window per session — at most one scan per 500ms. */
const SCAN_DEBOUNCE_MS = 500;

/** Throttle window for permission_prompt — avoid spam while prompt is on-screen. */
const PERMISSION_THROTTLE_MS = 10_000;

/** How many rendered lines to examine per scan. */
const TAIL_LINES = 30;

type LifecycleState = 'unknown' | 'working' | 'idle';

interface SessionScanState {
  timer: NodeJS.Timeout | null;
  lastState: LifecycleState;
  /** Highest Ctx threshold we have already emitted for (0 if none). */
  lastCtxCrossed: 0 | 30 | 50;
  /** ms epoch of the last permission_prompt emission for throttling. */
  lastPermissionAt: number;
}

function createState(): SessionScanState {
  return {
    timer: null,
    lastState: 'unknown',
    lastCtxCrossed: 0,
    lastPermissionAt: 0,
  };
}

/**
 * Spinner glyphs Claude Code renders while working. We deliberately cover the
 * v2.7 set (including the `✽`, `✻`, `⏺`, `✳` rotation plus the `⏳`/`✦`/`✧`
 * fallbacks observed in omni-watcher.cjs). Anchored at line start (after
 * optional whitespace) to avoid markdown/bullet false positives.
 */
const SPINNER_LINE_RE = /^\s*[✽✻⏺✳✢✶✣⏳✦✧]\s/;

/**
 * Verb-based fallback: Claude Code renders words like `Inferring…`,
 * `Pondering…`, `Crunching…` while thinking, often on the same spinner line.
 * We also accept the present-continuous-with-ellipsis shape as a working hint.
 */
const WORKING_VERB_RE = /\b(Inferring|Pondering|Crunching|Thinking|Working|Writing|Cooking|Brewing|Forging|Spinning|Computing|Processing|Reasoning)[.…]{1,3}/i;

/** Bare prompt line — the TUI's input caret when idle. */
const IDLE_PROMPT_RE = /^\s*[❯>]\s*$/;

/** Ctx percent — matches `Ctx: 38.0%` / `Ctx: 5%` / `Ctx:  12.3 %`. */
const CTX_PERCENT_RE = /Ctx:\s*(\d+(?:\.\d+)?)\s*%/;

/** Permission prompt patterns (any match fires). */
const PERMISSION_RES: readonly RegExp[] = [
  /\(y\/n\)|\(Y\/n\)|\[y\/N\]|Do you want to proceed/i,
  /^\s*1\.\s+.+\n\s*2\.\s+/m,
];

function detectLifecycle(lines: string[]): LifecycleState {
  const last5 = lines.slice(-5);
  const last15 = lines.slice(-15);

  const hasSpinner = last5.some((l) => SPINNER_LINE_RE.test(l) || WORKING_VERB_RE.test(l));
  if (hasSpinner) return 'working';

  const hasIdlePrompt = last15.some((l) => IDLE_PROMPT_RE.test(l));
  if (hasIdlePrompt) return 'idle';

  return 'unknown';
}

function detectCtxPercent(lines: string[]): number | null {
  // Scan from the bottom up — status bar is always at the tail.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(CTX_PERCENT_RE);
    if (m && m[1] !== undefined) {
      const pct = Number.parseFloat(m[1]);
      if (Number.isFinite(pct)) return pct;
    }
  }
  return null;
}

function findPermissionLine(lines: string[]): string | null {
  const joined = lines.join('\n');
  for (const re of PERMISSION_RES) {
    if (!re.test(joined)) continue;
    // Find the specific line that triggered the match for promptText.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line && (/\(y\/n\)|\(Y\/n\)|\[y\/N\]|Do you want to proceed/i.test(line) || /^\s*1\.\s+/.test(line))) {
        return line.trim().slice(0, 500);
      }
    }
    // Fallback to the last non-empty line if we somehow didn't pin it down.
    const tail = lines[lines.length - 1];
    return tail ? tail.trim().slice(0, 500) : null;
  }
  return null;
}

export function attachStatusBarEmitter(manager: PtyManager, bus: EventBus): () => void {
  const states = new Map<SessionId, SessionScanState>();

  const runScan = (sessionId: SessionId): void => {
    const state = states.get(sessionId);
    if (!state) return;
    state.timer = null;

    const lines = manager.renderedTail(sessionId, TAIL_LINES);
    if (lines.length === 0) return;

    // --- pane_idle: working -> idle transition ---
    const lifecycle = detectLifecycle(lines);
    if (lifecycle !== 'unknown') {
      if (state.lastState === 'working' && lifecycle === 'idle') {
        const payload: PayloadOf<'pane_idle'> = { type: 'pane_idle', sessionId };
        bus.publish(payload);
      }
      state.lastState = lifecycle;
    }

    // --- ctx_threshold: upward crossings at 30 / 50 ---
    const pct = detectCtxPercent(lines);
    if (pct !== null) {
      if (pct < 30) {
        // Panel compacted — reset so the next crossing re-fires.
        state.lastCtxCrossed = 0;
      } else if (pct >= 50 && state.lastCtxCrossed < 50) {
        if (state.lastCtxCrossed < 30) {
          const payload30: PayloadOf<'ctx_threshold'> = {
            type: 'ctx_threshold',
            sessionId,
            percent: pct,
            crossed: 30,
          };
          bus.publish(payload30);
        }
        const payload50: PayloadOf<'ctx_threshold'> = {
          type: 'ctx_threshold',
          sessionId,
          percent: pct,
          crossed: 50,
        };
        bus.publish(payload50);
        state.lastCtxCrossed = 50;
      } else if (pct >= 30 && state.lastCtxCrossed < 30) {
        const payload: PayloadOf<'ctx_threshold'> = {
          type: 'ctx_threshold',
          sessionId,
          percent: pct,
          crossed: 30,
        };
        bus.publish(payload);
        state.lastCtxCrossed = 30;
      }
    }

    // --- permission_prompt: throttled ---
    const promptText = findPermissionLine(lines);
    if (promptText) {
      const now = Date.now();
      if (now - state.lastPermissionAt >= PERMISSION_THROTTLE_MS) {
        state.lastPermissionAt = now;
        const payload: PayloadOf<'permission_prompt'> = {
          type: 'permission_prompt',
          sessionId,
          promptText,
        };
        bus.publish(payload);
      }
    }
  };

  const schedule = (sessionId: SessionId): void => {
    let state = states.get(sessionId);
    if (!state) {
      state = createState();
      states.set(sessionId, state);
    }
    if (state.timer !== null) return; // already pending
    state.timer = setTimeout(() => runScan(sessionId), SCAN_DEBOUNCE_MS);
  };

  const onData = (evt: PtyDataEvent): void => {
    schedule(evt.sessionId);
  };

  const onExit = (evt: PtyExitEvent): void => {
    const state = states.get(evt.sessionId);
    if (!state) return;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    states.delete(evt.sessionId);
  };

  manager.on('data', onData);
  manager.on('exit', onExit);

  return () => {
    manager.off('data', onData);
    manager.off('exit', onExit);
    for (const state of states.values()) {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    states.clear();
  };
}
