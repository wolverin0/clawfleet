#!/usr/bin/env node
/**
 * OmniClaude Unified Watcher — multiplexes events from 4 watched projects
 * + WezTerm session states into a single stdout stream for the Monitor tool.
 *
 * Designed for: Monitor({ command: "node .../omni-watcher.cjs", persistent: true, timeout_ms: 3500000 })
 *
 * Rules (from Monitor tool docs):
 * - Only stdout wakes Claude. Stderr is for internal debugging.
 * - grep --line-buffered in all pipes (pipe buffering delays events by minutes)
 * - || true after network calls (one failure must not kill the watcher)
 * - Pre-filter, dedupe, rate-limit BEFORE emitting to stdout
 * - Heartbeat every 5 min so OmniClaude can detect if watcher died
 * - Emit relaunch_me at 55 min so OmniClaude re-launches before the 1h timeout
 */

const { execFileSync, execFile } = require('child_process');
const { readFileSync, existsSync } = require('fs');
const path = require('path');

// --- Config ---
// POLL_INTERVAL_MS tuning: 5s was too aggressive. Each poll spawns N `wezterm cli`
// client processes (1 list + 1 get-text per pane). With 6 panes that's ≈7 calls/tick.
// At 5s that's 84 calls/min — enough to saturate the wezterm-gui mux socket buffer
// and freeze the GUI render thread after 1-2 days of continuous operation (os error
// 10054 "existing connection was forcibly closed" spam). 30s gives plenty of
// reactivity for session_completed events while staying well under socket limits.
const POLL_INTERVAL_MS = parseInt(process.env.WATCHER_POLL_MS || '30000', 10);
const HEARTBEAT_INTERVAL_MS = 300000; // 5 min heartbeat
const RELAUNCH_AT_MS = 3300000;       // 55 min — emit relaunch_me
const DEDUPE_TTL_MS = 120000;         // 2 min window for dedup
const MAX_EVENTS_PER_MIN = 10;        // rate limit per source

// --- Emit helpers ---
const emit = (event) => {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch { /* stdout closed, we're dying */ }
};

const log = (msg) => {
  process.stderr.write(`[omni-watcher] ${new Date().toISOString()} ${msg}\n`);
};

// --- Dedupe + rate limit ---
const recentEvents = new Map();
const rateCounts = new Map();

function shouldEmit(key) {
  const now = Date.now();

  // Dedupe: skip if same key emitted within TTL
  const lastSeen = recentEvents.get(key);
  if (lastSeen && now - lastSeen < DEDUPE_TTL_MS) return false;
  recentEvents.set(key, now);

  // Rate limit: max N events per source per minute
  const source = key.split(':')[0];
  const minuteKey = `${source}:${Math.floor(now / 60000)}`;
  const count = (rateCounts.get(minuteKey) || 0) + 1;
  rateCounts.set(minuteKey, count);
  if (count > MAX_EVENTS_PER_MIN) return false;

  return true;
}

// Cleanup old entries periodically
setInterval(() => {
  const cutoff = Date.now() - DEDUPE_TTL_MS * 2;
  for (const [k, v] of recentEvents) {
    if (v < cutoff) recentEvents.delete(k);
  }
  for (const [k] of rateCounts) {
    const minute = parseInt(k.split(':').pop());
    if (minute < Math.floor(Date.now() / 60000) - 2) rateCounts.delete(k);
  }
}, 60000);

// --- WezTerm session watcher (uses wezterm.cjs for socket handling) ---
const wez = require('./wezterm.cjs');

const paneStates = new Map(); // pane_id -> { project, status, hash, stuckSince, failCount }

// --- A2A envelope tracking ---
// Parse envelope headers in pane output so we can detect orphaned peers when
// one side of an exchange dies before replying. Tracked by `corr`; resolved
// when we see a `result`/`error` envelope for that corr. On session_removed
// the watcher emits `peer_orphaned` for the surviving partner.
const pendingA2A = new Map(); // corr -> { from, to, type, firstSeen, lastSeen }
// Expire stale corr entries after 1h even if never explicitly resolved
const A2A_MAX_AGE_MS = 3600000;

function scanA2AEnvelopes(lines) {
  const text = lines.join('\n');
  // New regex each call (global regex carries state across calls otherwise)
  const re = /\[A2A from pane-(\d+) to pane-(\d+) \| corr=([^\s|]+) \| type=(\w+)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const from = parseInt(match[1], 10);
    const to = parseInt(match[2], 10);
    const corr = match[3];
    const type = match[4];
    if (type === 'result' || type === 'error') {
      pendingA2A.delete(corr);
    } else if (type === 'request') {
      if (!pendingA2A.has(corr)) {
        pendingA2A.set(corr, { from, to, type, firstSeen: Date.now(), lastSeen: Date.now() });
      }
    } else if (pendingA2A.has(corr)) {
      // ack | progress — just refresh lastSeen
      pendingA2A.get(corr).lastSeen = Date.now();
    }
  }
}

// Expire stale A2A entries so we don't alert on ancient unresolved corrs
setInterval(() => {
  const now = Date.now();
  for (const [corr, info] of pendingA2A) {
    if (now - (info.lastSeen || info.firstSeen) > A2A_MAX_AGE_MS) {
      pendingA2A.delete(corr);
    }
  }
}, 600000);

function discoverPanes() {
  try {
    return wez.listPanes();
  } catch (err) {
    log(`wezterm list failed: ${err.message}`);
    return [];
  }
}

function getLastLines(paneId, n = 25) {
  try {
    const text = wez.getFullText(paneId);
    const lines = text.split('\n').filter(l => l.trim());
    return lines.slice(-n);
  } catch {
    return [];
  }
}

function detectStatus(lines) {
  const text = lines.join('\n');
  // Real permission prompts only — not the "bypass permissions on" status bar text
  // which contains the substring "permission" and causes constant false positives.
  // Match specific Claude Code permission prompt patterns.
  if (/\(y\/n\)|❯\s*1\.\s*Yes|do you want to proceed|approve this (command|action)|allow .+\?\s*\[/i.test(text)) return 'permission';

  // Claude Code's input area (footer with ❯) is ALWAYS visible regardless of state.
  // The reliable working/idle signal is the spinner glyph line above:
  //   - Working: "✢ Writing design doc… (1m 18s · ↓ 299 tokens)" — present-tense verb
  //     + ellipsis or live counter in parens
  //   - Idle/done: "✻ Brewed for 4m 51s" — past-tense verb + "for Xs"
  // Find the most recent spinner line in the tail and classify by its shape.
  // The spinner glyph must be at the START of the line (with optional whitespace) to
  // avoid false positives from markdown asterisks, bullet points, etc.
  const tail = lines.slice(-30);
  const spinnerRe = /^\s*[✢✻✶✽✣⏳✦✧]\s/;
  const spinnerLines = tail.filter(l => spinnerRe.test(l));
  const lastSpinner = spinnerLines[spinnerLines.length - 1];
  if (lastSpinner) {
    // Live counter pattern "(\d+m? ?\d*s? · ↓ N tokens)" or trailing ellipsis = working
    if (/…|\.\.\./.test(lastSpinner) || /\(\d+m?\s*\d*s?\s*·/.test(lastSpinner)) return 'working';
    // "Brewed for 5s" / "Cooked for 1m 32s" / "Worked for 11m 54s" = idle
    if (/\bfor\s+\d+(m|s)/.test(lastSpinner)) return 'idle';
  }

  // Fallback: bash $ prompt at bottom (non-Claude shell)
  if (tail.some(l => /^\s*\$\s*$/.test(l))) return 'idle';

  // No spinner found and we're in a Claude pane → assume working until we see a spinner
  // or a stale-state heuristic. Better to over-report working than miss a transition.
  return 'working';
}

function detectProject(pane) {
  // Derive project name dynamically from cwd basename — no hardcoded allowlist.
  // Falls back to title-derived slug, then "unknown".
  const cwd = (pane.cwd || '').replace(/\\/g, '/');
  if (cwd) {
    // Strip trailing slashes and take final segment
    const base = path.basename(cwd.replace(/\/+$/, ''));
    if (base && base !== '/') return base.toLowerCase();
  }
  const title = (pane.title || '').replace(/^[\s✳✶✻✽✢*]+/, '').trim();
  if (title) return title.toLowerCase().split(/\s+/)[0];
  return 'unknown';
}

function isClaude(pane) {
  // Robust detection: Claude Code renders "✳" (or similar star glyphs) in the pane title
  // when idle, plus a distinctive status bar pattern in the content. Title alone is not
  // reliable — custom session names (e.g. "paperclip-agent-consolidation") strip "claude".
  const title = pane.title || '';
  // (1) Title contains Claude Code marker glyph
  if (/[✳✶✻✽✢]/.test(title)) return true;
  // (2) Title explicitly says Claude Code
  if (/claude/i.test(title)) return true;
  // (3) Fallback: scan recent content for Claude's status bar pattern (bypass permissions, Ctx XX%)
  try {
    const text = wez.getFullText(pane.pane_id) || '';
    if (/bypass permissions on|Model: Opus|Model: Sonnet|Model: Haiku/.test(text) && /Ctx:\s*\d+/.test(text)) {
      return true;
    }
  } catch { /* pane unreadable */ }
  return false;
}

function pollWezterm() {
  const panes = discoverPanes();
  const claudePanes = panes.filter(isClaude);

  for (const pane of claudePanes) {
    const id = pane.pane_id;
    const project = detectProject(pane);
    const lines = getLastLines(id);
    const status = detectStatus(lines);
    const hash = lines.slice(-5).join('').length; // simple content hash

    const prev = paneStates.get(id);

    if (!prev) {
      // New session detected
      paneStates.set(id, { project, status, hash });
      const key = `wezterm:started:${id}`;
      if (shouldEmit(key)) {
        emit({ source: 'wezterm', project, event: 'session_started', pane: id, severity: 'info' });
      }
      continue;
    }

    // Status transition
    if (prev.status !== status) {
      const eventName =
        status === 'idle' && prev.status === 'working' ? 'session_completed' :
        status === 'permission' ? 'session_permission' :
        status === 'working' && prev.status === 'idle' ? 'session_started_working' :
        `session_${status}`;

      const severity =
        status === 'permission' ? 'P1' :
        eventName === 'session_completed' ? 'info' :
        'info';

      const key = `wezterm:${eventName}:${id}`;
      if (shouldEmit(key)) {
        const summary = status === 'permission'
          ? lines.slice(-3).join(' ').substring(0, 200)
          : lines.slice(-2).join(' ').substring(0, 150);

        emit({ source: 'wezterm', project, event: eventName, pane: id, severity, details: summary });
      }
    }

    // Stuck detection: working with no output change for 10 min
    if (status === 'working' && prev.status === 'working' && prev.hash === hash) {
      if (!prev.stuckSince) {
        prev.stuckSince = Date.now();
      } else if (Date.now() - prev.stuckSince > 600000) {
        const key = `wezterm:stuck:${id}`;
        if (shouldEmit(key)) {
          emit({ source: 'wezterm', project, event: 'session_stuck', pane: id, severity: 'P2',
                 details: `No output change for ${Math.round((Date.now() - prev.stuckSince) / 60000)} min` });
        }
      }
    } else {
      prev.stuckSince = null;
    }

    // Dead pane detection: 3 consecutive poll failures
    if (lines.length === 0) {
      const fc = (prev.failCount || 0) + 1;
      prev.failCount = fc;
      if (fc >= 3 && !prev.dead) {
        prev.dead = true;
        const key = `wezterm:dead:${id}`;
        if (shouldEmit(key)) {
          emit({ source: 'wezterm', project, event: 'session_dead', pane: id, severity: 'P2',
                 details: `3 consecutive poll failures — pane likely dead` });
        }
      }
    } else {
      prev.failCount = 0;
      prev.dead = false;
    }

    // Parse token metrics from status bar
    const metrics = parseStatusBar(lines);
    if (metrics) sessionMetrics.set(id, metrics);

    // Scan A2A envelope markers in this pane's tail
    scanA2AEnvelopes(lines);

    paneStates.set(id, { project, status, hash, stuckSince: prev.stuckSince, failCount: prev.failCount || 0, dead: prev.dead || false });
  }

  // Detect removed panes
  for (const [id, state] of paneStates) {
    if (!claudePanes.find(p => p.pane_id === id)) {
      const key = `wezterm:removed:${id}`;
      if (shouldEmit(key)) {
        emit({ source: 'wezterm', project: state.project, event: 'session_removed', pane: id, severity: 'info' });
      }
      // If the removed pane had any pending A2A exchanges, notify the survivor.
      for (const [corr, info] of pendingA2A) {
        if (info.from === id || info.to === id) {
          const survivor = info.from === id ? info.to : info.from;
          const emitKey = `wezterm:peer_orphaned:${corr}`;
          if (shouldEmit(emitKey)) {
            emit({
              source: 'wezterm', project: state.project, event: 'peer_orphaned',
              pane: survivor, severity: 'P1',
              details: `Peer pane-${id} died with pending A2A (corr=${corr}, was pane-${info.from}→pane-${info.to})`,
              corr, dead_peer: id, survivor,
            });
          }
          pendingA2A.delete(corr);
        }
      }
      paneStates.delete(id);
    }
  }
}

// --- Token/cost tracking ---
const sessionMetrics = new Map(); // pane_id -> { ctx, session, weekly, model }

// parseStatusBar moved to src/status-parser.cjs so pane-discovery.cjs can share it.
const { parseStatusBar } = require('./status-parser.cjs');

// Emit metrics summary every 10 min
setInterval(() => {
  if (sessionMetrics.size === 0) return;
  const summary = [];
  for (const [paneId, m] of sessionMetrics) {
    const state = paneStates.get(paneId);
    if (!state) continue;
    summary.push({ project: state.project, pane: paneId, ...m });
  }
  if (summary.length > 0) {
    emit({ source: 'watcher', event: 'metrics_summary', sessions: summary });
  }
}, 600000);

// --- Heartbeat ---
setInterval(() => {
  emit({ source: 'watcher', event: 'heartbeat', sessions: paneStates.size });
}, HEARTBEAT_INTERVAL_MS);

// --- Self-trigger relaunch at 55 min ---
setTimeout(() => {
  emit({ source: 'watcher', event: 'relaunch_me', reason: 'approaching_timeout' });
  log('Emitted relaunch_me. Exiting in 120s if not killed.');
  // Give OmniClaude 2 min to re-launch before we die from timeout
  setTimeout(() => {
    log('Timeout grace period expired. Exiting.');
    process.exit(0);
  }, 120000);
}, RELAUNCH_AT_MS);

// --- Main loop ---
log('Starting unified watcher...');
emit({
  source: 'watcher',
  event: 'watcher_started',
  poll_interval: POLL_INTERVAL_MS,
  heartbeat_interval: HEARTBEAT_INTERVAL_MS,
  relaunch_at: RELAUNCH_AT_MS,
});

// Initial poll
pollWezterm();

// Periodic poll
setInterval(() => {
  try {
    pollWezterm();
  } catch (err) {
    log(`Poll error: ${err.message}`);
  }
}, POLL_INTERVAL_MS);

// Graceful shutdown
process.on('SIGTERM', () => { log('SIGTERM received'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT received'); process.exit(0); });
