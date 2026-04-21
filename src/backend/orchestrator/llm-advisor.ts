/**
 * LLM advisor — the subjective-reasoning layer for the v3.0 orchestrator.
 *
 * The orchestrator's deterministic rule engine routes anything it can't decide
 * to `chat.ask`. That's safe but non-autonomous. The advisor gets ONE shot,
 * with full context (event + pane tail + dashboard snapshot + recent decisions),
 * to produce a verdict the executor can act on without user confirmation.
 *
 * Verdicts the advisor can emit:
 *   - 'mechanic'          → dispatch the original rule-proposed action
 *   - 'content'           → escalate to user (explicit acknowledgement of ambiguity)
 *   - 'dashboard_action'  → click/hover/focus/dblclick a ref (attested)
 *   - 'no_op'             → do nothing this tick
 *
 * Attested `dashboard_action`s bypass the "UI mutation = content" classifier
 * rule because the LLM is responsible for the call — see classifier.ts.
 *
 * Providers, in preference order:
 *   1. Anthropic API (direct fetch) — requires ANTHROPIC_API_KEY env.
 *   2. Claude CLI subprocess (`claude -p '<prompt>'`) — requires `claude` on PATH.
 *
 * Opt-in: THEORCHESTRA_LLM_ADVISOR=1. Defaults off so the app works without
 * any LLM setup.
 */

import { spawn } from 'node:child_process';

import type { Action, DecisionRecord } from './types.js';
import type { DashboardSnapshotPayload, DashboardController } from './dashboard-controller.js';
import type { SessionId, SseEvent } from '../../shared/types.js';
import type { PtyManager } from '../pty-manager.js';

export interface AdvisorInput {
  event: SseEvent;
  proposedAction: Action;
  paneTail: string[];
  snapshot: DashboardSnapshotPayload | null;
  recentDecisions: DecisionRecord[];
}

export type AdvisorVerdictKind = 'mechanic' | 'content' | 'dashboard_action' | 'no_op';

export interface AdvisorVerdict {
  verdict: AdvisorVerdictKind;
  /** Used when verdict === 'dashboard_action'. */
  ref?: string;
  actVerb?: 'click' | 'hover' | 'focus' | 'dblclick';
  reasoning: string;
  model: string;
  latencyMs: number;
  /** Set when the advisor bailed — downstream should fall back to rules. */
  error?: string;
}

export interface LlmAdvisorOptions {
  enabled: boolean;
  manager: PtyManager;
  dashboard?: DashboardController;
  /** Seconds between allowed advisor calls on the same pane. Default 30. */
  perPaneCooldownSec?: number;
  /** Global cap per rolling hour. Default 60. */
  globalHourlyCap?: number;
  /** Test hook — overrides provider selection. */
  providerOverride?: AdvisorProvider;
  /** Test clock. */
  now?: () => number;
}

export interface AdvisorProvider {
  name: string;
  modelId: string;
  call(prompt: string, timeoutMs: number): Promise<string>;
}

const SYSTEM_PROMPT = `You are the orchestrator for theorchestra, a tool that runs multiple Claude Code sessions concurrently.

You observe one session event at a time. The deterministic rule engine already proposed an action. Your job is to either endorse, downgrade, upgrade, or replace that action based on the context you're given.

OUTPUT CONTRACT — reply with ONE line of valid JSON, no prose around it:
{"verdict":"mechanic"|"content"|"dashboard_action"|"no_op","ref":"eN"?,"actVerb":"click|hover|focus|dblclick"?,"reasoning":"short why"}

Rules:
- "mechanic" = let the rule engine's proposed action proceed as-is.
- "content" = escalate to the user (ambiguity real; LLM can't decide).
- "dashboard_action" = you want the orchestrator to click/hover/focus/dblclick a dashboard ref (provide ref + actVerb). Only pick this if you have a concrete ref from the snapshot.
- "no_op" = do nothing this tick.

Be terse. Reasoning under 200 chars. No markdown.`;

function buildPrompt(input: AdvisorInput): string {
  const lines: string[] = [];
  lines.push(`event: ${JSON.stringify(input.event)}`);
  lines.push(`proposed: ${JSON.stringify(input.proposedAction)}`);
  if (input.paneTail.length > 0) {
    lines.push('pane last lines:');
    for (const l of input.paneTail.slice(-50)) lines.push(`  | ${l}`);
  }
  if (input.snapshot) {
    const refs = Object.entries(input.snapshot.refs ?? {}).slice(0, 30);
    lines.push(`dashboard refs (${input.snapshot.refsCount} total, showing first 30):`);
    for (const [k, v] of refs) lines.push(`  ${k}: ${v.name} [${v.role}]`);
  } else {
    lines.push('dashboard snapshot: unavailable');
  }
  if (input.recentDecisions.length > 0) {
    lines.push('recent decisions:');
    for (const d of input.recentDecisions.slice(-5)) {
      lines.push(`  ${d.ts.slice(11, 19)} ${d.action.kind} ${d.classification.verdict}`);
    }
  }
  return `${SYSTEM_PROMPT}\n\n---CONTEXT---\n${lines.join('\n')}\n---END---\nYour JSON output:`;
}

/** Anthropic API direct fetch provider. Null if no API key. */
function anthropicProvider(): AdvisorProvider | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const modelId = process.env.THEORCHESTRA_LLM_MODEL ?? 'claude-haiku-4-5-20251001';
  return {
    name: 'anthropic-api',
    modelId,
    async call(prompt: string, timeoutMs: number): Promise<string> {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 400,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`anthropic ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as { content?: Array<{ text?: string }> };
      return body.content?.[0]?.text ?? '';
    },
  };
}

/** Claude CLI subprocess provider. Null if `claude` not on PATH. */
function claudeCliProvider(): AdvisorProvider | null {
  const modelId = process.env.THEORCHESTRA_LLM_MODEL ?? 'claude-haiku-4-5-20251001';
  return {
    name: 'claude-cli',
    modelId,
    call(prompt: string, timeoutMs: number): Promise<string> {
      return new Promise((resolve, reject) => {
        const args = ['-p', prompt, '--model', modelId];
        const child = spawn('claude', args, {
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`claude cli timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (d) => (out += d.toString()));
        child.stderr.on('data', (d) => (err += d.toString()));
        child.on('exit', (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve(out);
          else reject(new Error(`claude cli exit ${code}: ${err.slice(0, 200)}`));
        });
        child.on('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        });
      });
    },
  };
}

function parseVerdict(raw: string, model: string, latencyMs: number): AdvisorVerdict {
  // Claude CLI sometimes wraps output in prose despite instructions. Extract
  // the first {...} JSON object.
  const jsonMatch = raw.match(/\{[^{}]*"verdict"[^{}]*\}/);
  const payload = jsonMatch ? jsonMatch[0] : raw.trim();
  try {
    const parsed = JSON.parse(payload) as {
      verdict?: unknown;
      ref?: unknown;
      actVerb?: unknown;
      reasoning?: unknown;
    };
    const kinds: AdvisorVerdictKind[] = ['mechanic', 'content', 'dashboard_action', 'no_op'];
    if (typeof parsed.verdict !== 'string' || !kinds.includes(parsed.verdict as AdvisorVerdictKind)) {
      throw new Error(`bad verdict: ${parsed.verdict}`);
    }
    const verdict: AdvisorVerdict = {
      verdict: parsed.verdict as AdvisorVerdictKind,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 400) : '(no reason given)',
      model,
      latencyMs,
    };
    if (verdict.verdict === 'dashboard_action') {
      if (typeof parsed.ref !== 'string' || !/^e\d+$/.test(parsed.ref)) {
        throw new Error(`dashboard_action requires valid ref; got ${parsed.ref}`);
      }
      const verbs = ['click', 'hover', 'focus', 'dblclick'];
      if (typeof parsed.actVerb !== 'string' || !verbs.includes(parsed.actVerb)) {
        throw new Error(`dashboard_action requires actVerb; got ${parsed.actVerb}`);
      }
      verdict.ref = parsed.ref;
      verdict.actVerb = parsed.actVerb as AdvisorVerdict['actVerb'];
    }
    return verdict;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return {
      verdict: 'no_op',
      reasoning: `parse error: ${m.slice(0, 200)}; raw: ${raw.slice(0, 200)}`,
      model,
      latencyMs,
      error: m,
    };
  }
}

export class LlmAdvisor {
  private readonly perPaneLastCall = new Map<SessionId, number>();
  private readonly globalCalls: number[] = [];
  private readonly provider: AdvisorProvider | null;
  private readonly perPaneCooldownMs: number;
  private readonly globalHourlyCap: number;
  private readonly now: () => number;

  constructor(private readonly opts: LlmAdvisorOptions) {
    this.perPaneCooldownMs = (opts.perPaneCooldownSec ?? 30) * 1000;
    this.globalHourlyCap = opts.globalHourlyCap ?? 60;
    this.now = opts.now ?? Date.now;
    if (opts.providerOverride) {
      this.provider = opts.providerOverride;
    } else if (opts.enabled) {
      this.provider = anthropicProvider() ?? claudeCliProvider();
    } else {
      this.provider = null;
    }
  }

  get enabled(): boolean {
    return this.opts.enabled && this.provider !== null;
  }

  get providerName(): string {
    return this.provider?.name ?? 'none';
  }

  get modelId(): string {
    return this.provider?.modelId ?? 'none';
  }

  get stats(): { callsThisHour: number; cooldownsActive: number } {
    const now = this.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    while (this.globalCalls.length > 0 && this.globalCalls[0]! < oneHourAgo) {
      this.globalCalls.shift();
    }
    let cooldowns = 0;
    for (const ts of this.perPaneLastCall.values()) {
      if (now - ts < this.perPaneCooldownMs) cooldowns++;
    }
    return { callsThisHour: this.globalCalls.length, cooldownsActive: cooldowns };
  }

  async advise(input: AdvisorInput): Promise<AdvisorVerdict> {
    const model = this.provider?.modelId ?? 'disabled';
    if (!this.enabled || !this.provider) {
      return {
        verdict: 'content',
        reasoning: 'advisor disabled; falling through to rule-engine verdict',
        model,
        latencyMs: 0,
        error: 'disabled',
      };
    }
    const now = this.now();
    // Global cap
    const stats = this.stats;
    if (stats.callsThisHour >= this.globalHourlyCap) {
      return {
        verdict: 'content',
        reasoning: `hourly cap (${this.globalHourlyCap}) reached`,
        model,
        latencyMs: 0,
        error: 'hourly-cap',
      };
    }
    // Per-pane cooldown
    const sid =
      'sessionId' in input.event && input.event.sessionId ? input.event.sessionId : null;
    if (sid) {
      const last = this.perPaneLastCall.get(sid);
      if (last !== undefined && now - last < this.perPaneCooldownMs) {
        return {
          verdict: 'content',
          reasoning: `per-pane cooldown (${this.perPaneCooldownMs / 1000}s)`,
          model,
          latencyMs: 0,
          error: 'cooldown',
        };
      }
    }
    const prompt = buildPrompt(input);
    const t0 = this.now();
    let raw: string;
    try {
      raw = await this.provider.call(prompt, 5000);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return {
        verdict: 'content',
        reasoning: `provider error; fall back: ${m.slice(0, 200)}`,
        model,
        latencyMs: this.now() - t0,
        error: m,
      };
    }
    if (sid) this.perPaneLastCall.set(sid, now);
    this.globalCalls.push(now);
    return parseVerdict(raw, model, this.now() - t0);
  }
}
