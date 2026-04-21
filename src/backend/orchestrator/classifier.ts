/**
 * Classifier + safety rails for the v3.0 active orchestrator.
 *
 * The executor asks `classifyAction(action, context)` for every candidate
 * action a rule produces. The classifier says:
 *   - 'mechanics' → safe to run autonomously (OK CONTINUE, ack peer A2A, etc)
 *   - 'content'   → must escalate to user (merge, design decision, etc)
 *   - 'blocked'   → safety rail says no (cooldown, loop, destructive keyword)
 *
 * Safety rails encoded here (from v2.x orchestrator-executor.cjs spec):
 *   1. Cooldown — max 1 auto-`continue` per session per 90s
 *   2. Loop detection — same action on same session 3x in 5min → block
 *   3. Destructive keyword scan — text contains rm -rf, drop, push, migrate
 *      → force 'content' classification
 *   4. Per-project denylist — vault/_orchestrator-config.md "Never-Auto
 *      Projects" always escalate
 *   5. No self-actions — refuse actions targeting the orchestrator itself
 */

import * as fs from 'node:fs';

import type { SessionId } from '../../shared/types.js';
import type { Action, Classification } from './types.js';

export interface ClassifierContext {
  /** Map sessionId → path-basename so we can match denylist entries. */
  projectOf: (sessionId: SessionId) => string | null;
  /** The orchestrator's own session (if it runs in-pane); actions against this are blocked. */
  selfSessionId?: SessionId | null;
  /** Path to vault/_orchestrator-config.md (denylist source). Optional. */
  configPath?: string;
  /** Current time injection for tests. */
  now?: () => number;
}

/**
 * Words that, when present in `continue` text or `send_key` key, kick the
 * action up to 'content' so the user has to confirm. Case-insensitive,
 * substring match.
 */
const DESTRUCTIVE_KEYWORDS = [
  'rm -rf',
  'rmdir /s',
  'drop table',
  'drop database',
  'git push --force',
  'force-push',
  'git reset --hard',
  'migrate',
  'deploy',
  'prod',
  'production',
  'delete from',
  'truncate ',
];

function textContent(action: Action): string {
  switch (action.kind) {
    case 'continue':
      return action.text ?? '';
    case 'send_key':
      return action.key;
    default:
      return '';
  }
}

export class SafetyState {
  private readonly contGuards = new Map<SessionId, number>(); // last continue ts
  private readonly recentActions = new Map<string, number[]>(); // key → ts list

  recordContinue(sessionId: SessionId, ts: number): void {
    this.contGuards.set(sessionId, ts);
  }

  recordAction(key: string, ts: number): void {
    const list = this.recentActions.get(key) ?? [];
    list.push(ts);
    // Keep only the last 5 minutes so the map doesn't grow unboundedly.
    const cutoff = ts - 5 * 60 * 1000;
    while (list.length > 0 && list[0]! < cutoff) list.shift();
    this.recentActions.set(key, list);
  }

  isInCooldown(sessionId: SessionId, now: number): boolean {
    const last = this.contGuards.get(sessionId);
    return last !== undefined && now - last < 90_000;
  }

  /**
   * True if this attempt would be the 3rd (or later) occurrence within 5
   * minutes. The recorder tracks successfully-dispatched actions; at the
   * 3rd attempt there are 2 recorded, and we want the 3rd to be blocked —
   * so the threshold is `>= 2` recorded.
   */
  isLooping(key: string, now: number): boolean {
    const list = this.recentActions.get(key) ?? [];
    const cutoff = now - 5 * 60 * 1000;
    const recent = list.filter((t) => t >= cutoff);
    return recent.length >= 2;
  }
}

function readDenylist(configPath: string | undefined): Set<string> {
  if (!configPath) return new Set();
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    const section = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const out = new Set<string>();
    let inSection = false;
    for (const line of section) {
      if (/^#+\s*Never-Auto Projects/i.test(line)) {
        inSection = true;
        continue;
      }
      if (inSection && /^#/.test(line)) {
        // Next section started.
        break;
      }
      if (inSection && line.startsWith('-')) {
        const name = line.slice(1).trim();
        if (name.length > 0) out.add(name.toLowerCase());
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Classify an action. Caller is responsible for recording the action in the
 * SafetyState once it's actually dispatched (so failed/blocked actions don't
 * count against future cooldowns).
 */
export function classifyAction(
  action: Action,
  safety: SafetyState,
  context: ClassifierContext,
): Classification {
  const now = (context.now ?? Date.now)();

  // Rail 5 — no self-actions.
  if (
    'sessionId' in action &&
    action.sessionId !== null &&
    action.sessionId === context.selfSessionId
  ) {
    return { verdict: 'blocked', reason: 'self_action refused' };
  }

  // Rail 4 — denylist (project-level).
  if ('sessionId' in action && action.sessionId != null) {
    const project = context.projectOf(action.sessionId);
    if (project) {
      const denylist = readDenylist(context.configPath);
      if (denylist.has(project.toLowerCase())) {
        return { verdict: 'content', reason: `project "${project}" is in denylist — escalate` };
      }
    }
  }

  // Rail 1 — cooldown on continues.
  if (action.kind === 'continue') {
    if (safety.isInCooldown(action.sessionId, now)) {
      return { verdict: 'blocked', reason: 'continue cooldown (<90s since last)' };
    }
  }

  // Rail 2 — loop detection across all actions on the same target.
  if ('sessionId' in action && action.sessionId != null) {
    const key = `${action.kind}|${action.sessionId}`;
    if (safety.isLooping(key, now)) {
      return { verdict: 'blocked', reason: 'loop detected (3x in 5min)' };
    }
  }

  // Rail 3 — destructive keyword scan on continues and keys.
  const body = textContent(action).toLowerCase();
  if (body.length > 0) {
    for (const kw of DESTRUCTIVE_KEYWORDS) {
      if (body.includes(kw)) {
        return { verdict: 'content', reason: `destructive keyword "${kw}" — needs user confirm` };
      }
    }
  }

  // Classify by action kind.
  switch (action.kind) {
    case 'continue':
    case 'send_key':
    case 'auto_handoff':
      return { verdict: 'mechanics', reason: `${action.kind} is a routine mechanic` };
    case 'kill':
      // Killing a pane is dangerous enough to always escalate.
      return { verdict: 'content', reason: 'kill_session is always content — user confirms' };
    case 'escalate_to_user':
      return { verdict: 'content', reason: 'explicit escalation' };
    case 'dashboard_action':
      // Read-only snapshot = mechanics. Any UI-mutating verb (click/etc.)
      // touches user-visible state. Default: content (user-confirm).
      // Exception: attested by the LLM advisor → mechanics, because the
      // advisor is responsible for the call. The executor records the
      // attestation reasoning on the decision record.
      if (action.verb === 'snapshot') {
        return { verdict: 'mechanics', reason: 'dashboard snapshot is read-only' };
      }
      if (action.attestation && action.attestation.by === 'llm-advisor') {
        return {
          verdict: 'mechanics',
          reason: `dashboard ${action.verb} attested by llm-advisor`,
        };
      }
      return { verdict: 'content', reason: `dashboard ${action.verb} needs user confirm` };
    case 'no_op':
      return { verdict: 'mechanics', reason: 'no-op' };
  }
}
