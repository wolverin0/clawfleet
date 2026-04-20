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
import type { Action, Classification, DecisionRecord } from './types.js';

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
}

export interface OrchestratorHandles {
  stop: () => void;
  chat: ChatStore;
  log: DecisionLog;
  safety: SafetyState;
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
  const chat = new ChatStore(bus, opts.telegram);

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

  async function dispatch(action: Action, classification: Classification): Promise<boolean> {
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

  async function handle(event: SseEvent): Promise<DecisionRecord[]> {
    const now = (opts.now ?? Date.now)();
    const actions = proposeActions(event, manager, opts.rules);
    const records: DecisionRecord[] = [];
    for (const action of actions) {
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
        record.executed = await dispatch(action, classification);
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
    _dispatchForTest: handle,
  };
}
