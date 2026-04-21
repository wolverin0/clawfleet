/**
 * Executor loop — the active orchestrator's heart.
 *
 *   1. Subscribe to SSE events from the bus.
 *   2. For each event, ask `proposeActions(event, manager)` for candidate actions.
 *   3. Pass each action through `classifyAction(action, safety, ctx)`.
 *   4. If 'mechanics': dispatch via PtyManager / backend HTTP helpers.
 *   5. If 'content': post an `ask` to the ChatStore and await user answer
 *      (Phase 8 adds Telegram push; for now the dashboard polls).
 *   6. If 'blocked': record the decision, do nothing.
 *   7. Append every decision to the DecisionLog.
 *
 * Phase 7 dispatches mechanics via PtyManager directly (in-process) for
 * Phase 7's scope — avoiding an HTTP hop into the same process. Phase 9
 * auth may change this.
 */

import * as path from 'node:path';

import type { PtyManager } from '../pty-manager.js';
import type { EventBus } from '../events.js';
import type { SseEvent, SessionId } from '../../shared/types.js';
import { runAutoHandoff } from '../auto-handoff.js';
import type { TelegramPusher } from '../telegram-push.js';

import { SafetyState, classifyAction, type ClassifierContext } from './classifier.js';
import { proposeActions, type RuleConfig } from './rules.js';
import { DecisionLog } from './decision-log.js';
import { ChatStore } from './chat.js';
import type { DashboardController } from './dashboard-controller.js';
import type { LlmAdvisor } from './llm-advisor.js';
import type { Action, ActionAttestation, Classification, DecisionRecord } from './types.js';

export interface ExecutorOptions {
  /** Path to vault/_orchestrator-config.md for denylist reads. */
  configPath?: string;
  /** Path to vault/_orchestrator/ dir for decision logs. */
  decisionsDir: string;
  /** If the orchestrator itself has a session pane, pass its id so we refuse self-actions. */
  selfSessionId?: SessionId | null;
  /** Override rules (e.g. loosen OK-CONTINUE detection in tests). */
  rules?: RuleConfig;
  /** Test clock. */
  now?: () => number;
  /** Optional Telegram pusher — wired into the ChatStore for ask() notifications. */
  telegram?: TelegramPusher;
  /**
   * Optional dashboard controller. If present, every orchestrator-originated
   * `ask()` attaches an agent-browser snapshot of the dashboard asynchronously,
   * and `dashboard_action` actions become dispatchable.
   */
  dashboard?: DashboardController;
  /**
   * Optional LLM advisor. When enabled, content-class decisions are routed
   * through the advisor first. The advisor can downgrade content → mechanic,
   * propose a `dashboard_action`, escalate, or no-op. See llm-advisor.ts.
   */
  advisor?: LlmAdvisor;
}

export interface OrchestratorHandles {
  stop: () => void;
  chat: ChatStore;
  log: DecisionLog;
  safety: SafetyState;
  dashboard?: DashboardController;
  advisor?: LlmAdvisor;
  /** For gate tests — inject an SSE event as if it had arrived from the bus. */
  _dispatchForTest: (event: SseEvent) => Promise<DecisionRecord[]>;
}

export function startOrchestrator(
  manager: PtyManager,
  bus: EventBus,
  opts: ExecutorOptions,
): OrchestratorHandles {
  const safety = new SafetyState();
  const log = new DecisionLog(opts.decisionsDir);
  // Pass the dashboard controller as a snapshot provider so every ask()
  // attaches a dashboard a11y snapshot asynchronously. If no controller was
  // given (or it's disabled), ChatStore simply never fires the provider.
  const snapshotProvider =
    opts.dashboard && opts.dashboard.enabled
      ? () => opts.dashboard!.snapshot()
      : undefined;
  const chat = new ChatStore(bus, opts.telegram, snapshotProvider);

  const projectOf = (sessionId: SessionId): string | null => {
    const rec = manager.get(sessionId);
    if (!rec) return null;
    return path.basename(rec.cwd) || rec.cwd;
  };

  const ctx: ClassifierContext = {
    projectOf,
    selfSessionId: opts.selfSessionId ?? null,
    configPath: opts.configPath,
    now: opts.now,
  };

  async function dispatch(
    action: Action,
    classification: Classification,
    currentRecord: DecisionRecord,
  ): Promise<boolean> {
    if (classification.verdict === 'blocked') return false;
    if (classification.verdict === 'content') {
      if (action.kind === 'escalate_to_user') {
        chat.ask(action.sessionId, action.topic, action.detail);
        return true;
      }
      // For non-escalate content actions (e.g. a destructive continue), we
      // still need to ask the user — package it as an ask.
      const sid = 'sessionId' in action && action.sessionId ? action.sessionId : null;
      chat.ask(
        sid,
        action.kind,
        `Orchestrator wants to ${action.kind}${sid ? ` on pane ${sid.slice(0, 8)}…` : ''}. Reason: ${classification.reason}`,
      );
      return true;
    }

    // mechanics
    switch (action.kind) {
      case 'continue': {
        const text = action.text ?? 'ok continue\r';
        manager.write(action.sessionId, text.endsWith('\r') ? text : text + '\r');
        safety.recordContinue(action.sessionId, (opts.now ?? Date.now)());
        return true;
      }
      case 'send_key': {
        // The key aliases are translated at the HTTP layer; in-process we
        // just write the raw bytes. Callers construct send_key actions with
        // the actual byte sequence they want.
        manager.write(action.sessionId, action.key);
        return true;
      }
      case 'auto_handoff': {
        // Fire-and-forget so the event loop doesn't block on the full
        // handoff flow (which can take minutes).
        runAutoHandoff(manager, bus, action.sessionId, {
          focus: action.focus,
          force: action.force,
        }).catch((err) => {
          process.stderr.write(
            `[orchestrator] auto_handoff failed for ${action.sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
        return true;
      }
      case 'dashboard_action': {
        if (!opts.dashboard || !opts.dashboard.enabled) {
          return false;
        }
        if (action.verb === 'snapshot') {
          opts.dashboard.snapshot().catch(() => {});
          return true;
        }
        if (!action.ref) return false;
        // Pre-snapshot refs count is cheap if a recent snapshot exists via
        // the advisor path. We attach post-snapshot fields by mutating the
        // record AFTER the async act completes. The record itself has been
        // log.append()'d already — but the in-memory ring still holds the
        // same object reference, so mutation shows up on /api/decisions.
        const verb = action.verb as 'click' | 'hover' | 'focus' | 'dblclick';
        (async () => {
          const preSnap = await opts.dashboard!.snapshot().catch(() => null);
          const actResult = await opts.dashboard!.act(action.ref!, verb);
          const postSnap = actResult.ok
            ? await new Promise<Awaited<ReturnType<typeof opts.dashboard.snapshot>> | null>((r) =>
                setTimeout(() => opts.dashboard!.snapshot().then(r).catch(() => r(null)), 1500),
              )
            : null;
          currentRecord.metadata = {
            ...(currentRecord.metadata ?? {}),
            act_ok: actResult.ok,
            act_error: actResult.ok ? undefined : actResult.error,
            pre_refs_count: preSnap?.refsCount,
            post_refs_count: postSnap?.refsCount,
            pre_snapshot_at: preSnap?.capturedAt,
            post_snapshot_at: postSnap?.capturedAt,
          };
          if (!actResult.ok) {
            process.stderr.write(
              `[orchestrator] dashboard_action ${verb} ${action.ref} failed: ${actResult.error}\n`,
            );
          }
        })().catch(() => {});
        return true;
      }
      case 'no_op':
        return true;
      case 'kill':
      case 'escalate_to_user':
        // These are 'content' in practice; classifier routed them here as
        // mechanics only if an override changed that. Play safe: escalate.
        chat.ask(
          'sessionId' in action && action.sessionId ? action.sessionId : null,
          action.kind,
          `Orchestrator produced ${action.kind}; escalating anyway.`,
        );
        return true;
    }
  }

  async function maybeReviseWithAdvisor(
    event: SseEvent,
    proposed: Action,
    baselineVerdict: Classification['verdict'],
  ): Promise<Action> {
    // Only invoke on content-class baseline decisions. Mechanics go through
    // as-is (advisor would add latency + cost with nothing to gain).
    if (!opts.advisor || !opts.advisor.enabled) return proposed;
    if (baselineVerdict !== 'content') return proposed;

    const sid =
      'sessionId' in proposed && proposed.sessionId ? proposed.sessionId : null;
    const paneTail = sid ? manager.renderedTail(sid, 50) : [];
    const snapshot = opts.dashboard && opts.dashboard.enabled ? await opts.dashboard.snapshot() : null;
    const recentDecisions = log.tail(20);

    const verdict = await opts.advisor.advise({
      event,
      proposedAction: proposed,
      paneTail,
      snapshot,
      recentDecisions,
    });

    const attestation: ActionAttestation = {
      by: 'llm-advisor',
      reasoning: verdict.reasoning,
      model: verdict.model,
      latencyMs: verdict.latencyMs,
    };

    // Apply verdict. For any error path the advisor already falls back to
    // 'content' with error metadata — we thread that back as the original
    // proposed action (rule-engine default).
    if (verdict.error) return proposed;

    switch (verdict.verdict) {
      case 'mechanic':
        // Advisor endorses the rule-proposed action as-is; keep it but tag.
        return { ...proposed, attestation };
      case 'content':
        // Advisor agrees we should escalate.
        return proposed;
      case 'no_op':
        return { kind: 'no_op', reason: `advisor no_op: ${verdict.reasoning}`, attestation };
      case 'dashboard_action':
        if (!verdict.ref || !verdict.actVerb) return proposed;
        return {
          kind: 'dashboard_action',
          verb: verdict.actVerb,
          ref: verdict.ref,
          sessionId: sid,
          reason: verdict.reasoning,
          attestation,
        };
    }
  }

  async function handle(event: SseEvent): Promise<DecisionRecord[]> {
    const now = (opts.now ?? Date.now)();
    const actions = proposeActions(event, manager, opts.rules);
    const records: DecisionRecord[] = [];
    for (const proposed of actions) {
      // Ask the advisor FIRST (before classifying) if the baseline rule-engine
      // verdict would be 'content'. The advisor can revise the Action.
      const baseline = classifyAction(proposed, safety, ctx);
      const action = await maybeReviseWithAdvisor(event, proposed, baseline.verdict);
      const classification = classifyAction(action, safety, ctx);
      const record: DecisionRecord = {
        ts: new Date(now).toISOString(),
        sessionId:
          'sessionId' in action && action.sessionId ? action.sessionId : null,
        trigger: `${event.type}#${event.id}`,
        action,
        classification,
        executed: false,
      };
      try {
        record.executed = await dispatch(action, classification, record);
      } catch (err) {
        record.notes = `dispatch error: ${err instanceof Error ? err.message : String(err)}`;
      }
      // Record AFTER dispatch so loop detection only counts real attempts.
      if (record.executed && 'sessionId' in action && action.sessionId) {
        safety.recordAction(`${action.kind}|${action.sessionId}`, now);
      }
      log.append(record);
      records.push(record);
    }
    return records;
  }

  const unsubscribe = bus.subscribe((evt) => {
    handle(evt).catch((err) => {
      process.stderr.write(
        `[orchestrator] handle(${evt.type}) failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  });

  return {
    stop: () => unsubscribe(),
    chat,
    log,
    safety,
    dashboard: opts.dashboard,
    advisor: opts.advisor,
    _dispatchForTest: handle,
  };
}
