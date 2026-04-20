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
  lastCtxCrossed: 0 | 40 | 60 | 70;
  /** ms epoch of the last permission_prompt emission for throttling. */
  lastPermissionAt: number;
  /** Last raw ctx% we parsed — exposed through the /status endpoint. */
  lastCtxPercent: number | null;
  /** ms epoch of the last pane_idle we emitted. Prevents duplicates when
   *  repeated scans keep observing the idle state, but still lets a fresh
   *  burst of pty data → idle fire again. */
  lastIdleFiredAt: number;
}

function createState(): SessionScanState {
  return {
    timer: null,
    lastState: 'unknown',
    lastCtxCrossed: 0,
    lastPermissionAt: 0,
    lastCtxPercent: null,
    lastIdleFiredAt: 0,
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

/**
 * Bare prompt line — the TUI's input caret when idle. Includes the xterm-
 * rendered variants that come out as surrogate-pair garbage on some fonts
 * (`\ud83d\udc9d` etc — Claude Code TUI's `❯` arrow doesn't survive
 * xterm-headless cleanly on Windows ConPTY). We accept ANY short line
 * that's dominated by non-letter/non-digit glyphs and sits between two
 * horizontal rules (`────…`), which is the idle-prompt signature.
 */
const IDLE_PROMPT_RE = /^\s*[❯>]\s*$/;
const IDLE_RULE_RE = /^[\s─]+$/; // the horizontal rules bracketing the prompt
/** A short, letter-free line that looks like the prompt caret after TUI rendering. */
function isLikelyPromptCaret(line: string): boolean {
  if (line.length === 0 || line.length > 16) return false;
  // If the line is entirely letters/digits, it's almost certainly content, not a caret.
  if (/^[\s\w.]+$/.test(line)) return false;
  // A caret line is mostly spaces with at most a handful of non-space glyphs.
  const nonSpace = line.replace(/\s/g, '');
  return nonSpace.length >= 1 && nonSpace.length <= 4;
}

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

  // Primary idle signal: bare `❯`/`>` line in the last 15.
  if (last15.some((l) => IDLE_PROMPT_RE.test(l))) return 'idle';
  // Secondary idle signal: xterm-headless sometimes mangles Claude's `❯` into
  // surrogate-pair garbage (observed on Windows ConPTY 2026-04-20). If the
  // recent tail contains two horizontal rules with a short, letter-free line
  // sandwiched between them, that IS the Claude idle-prompt signature.
  for (let i = last15.length - 3; i >= 0; i--) {
    const a = last15[i];
    const b = last15[i + 1];
    const c = last15[i + 2];
    if (!a || !b || !c) continue;
    if (IDLE_RULE_RE.test(a) && isLikelyPromptCaret(b) && IDLE_RULE_RE.test(c)) {
      return 'idle';
    }
  }

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

/**
 * Module-scoped ctx% cache. Populated by the emitter's scan loop; read by
 * the /status endpoint + the auto-handoff watchdog. Keyed by session id.
 */
const lastCtxPercentCache = new Map<SessionId, number>();

export function getLastCtxPercent(sessionId: SessionId): number | null {
  return lastCtxPercentCache.get(sessionId) ?? null;
}

export function attachStatusBarEmitter(manager: PtyManager, bus: EventBus): () => void {
  const states = new Map<SessionId, SessionScanState>();

  const runScan = (sessionId: SessionId): void => {
    const state = states.get(sessionId);
    if (!state) return;
    state.timer = null;

    const lines = manager.renderedTail(sessionId, TAIL_LINES);
    if (lines.length === 0) return;

    // --- pane_idle: fire whenever we detect idle on a scan that was
    // triggered AFTER the last idle-fire by fresh pty data. Using pty
    // quiescence as the gate is more robust than tracking state.lastState
    // through the working→idle edge, because detectLifecycle frequently
    // returns 'unknown' during Claude's working phase (spinner glyphs
    // don't always render cleanly in xterm-headless on ConPTY). Every
    // data burst that settles into idle fires exactly one pane_idle.
    const lifecycle = detectLifecycle(lines);
    if (lifecycle === 'idle') {
      const lastData = manager.lastDataAt(sessionId) ?? 0;
      if (lastData > state.lastIdleFiredAt) {
        state.lastIdleFiredAt = lastData;
        const payload: PayloadOf<'pane_idle'> = { type: 'pane_idle', sessionId };
        bus.publish(payload);
      }
    }
    if (lifecycle !== 'unknown') state.lastState = lifecycle;

    // --- ctx_threshold: upward crossings at 40 (suggest) / 60 (critical) / 70 (automatic) ---
    const pct = detectCtxPercent(lines);
    if (pct !== null) {
      state.lastCtxPercent = pct;
      lastCtxPercentCache.set(sessionId, pct);
      if (pct < 40) {
        // Panel compacted — reset so the next crossing re-fires.
        state.lastCtxCrossed = 0;
      } else if (pct >= 70 && state.lastCtxCrossed < 70) {
        // Backfill missed thresholds so listeners see them in order.
        if (state.lastCtxCrossed < 40) {
          bus.publish({ type: 'ctx_threshold', sessionId, percent: pct, crossed: 40 });
        }
        if (state.lastCtxCrossed < 60) {
          bus.publish({ type: 'ctx_threshold', sessionId, percent: pct, crossed: 60 });
        }
        bus.publish({ type: 'ctx_threshold', sessionId, percent: pct, crossed: 70 });
        state.lastCtxCrossed = 70;
      } else if (pct >= 60 && state.lastCtxCrossed < 60) {
        if (state.lastCtxCrossed < 40) {
          bus.publish({ type: 'ctx_threshold', sessionId, percent: pct, crossed: 40 });
        }
        bus.publish({ type: 'ctx_threshold', sessionId, percent: pct, crossed: 60 });
        state.lastCtxCrossed = 60;
      } else if (pct >= 40 && state.lastCtxCrossed < 40) {
        bus.publish({ type: 'ctx_threshold', sessionId, percent: pct, crossed: 40 });
        state.lastCtxCrossed = 40;
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
