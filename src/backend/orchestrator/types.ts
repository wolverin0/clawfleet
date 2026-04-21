/**
 * Shared types for the v3.0 active orchestrator. Lives in src/backend so the
 * executor can import without crossing package boundaries; the dashboard
 * frontend will import whatever subset it needs via the existing shared
 * directory later.
 */

import type { SessionId } from '../../shared/types.js';

/**
 * Attestation proves that a non-deterministic authority (e.g. the LLM advisor)
 * has vouched for an Action. The classifier honors attestations to let the
 * orchestrator auto-drive the UI when the advisor is confident.
 */
export interface ActionAttestation {
  by: 'llm-advisor';
  reasoning: string;
  model: string;
  latencyMs: number;
}

/** What the orchestrator wants to do in response to an event. */
export type Action =
  | ({ kind: 'continue'; sessionId: SessionId; text?: string } & { attestation?: ActionAttestation })
  | ({ kind: 'send_key'; sessionId: SessionId; key: string } & { attestation?: ActionAttestation })
  | ({ kind: 'kill'; sessionId: SessionId } & { attestation?: ActionAttestation })
  | ({ kind: 'auto_handoff'; sessionId: SessionId; focus?: string; force?: boolean } & { attestation?: ActionAttestation })
  | ({ kind: 'escalate_to_user'; sessionId: SessionId | null; topic: string; detail: string } & { attestation?: ActionAttestation })
  | ({
      /**
       * Drive the dashboard itself via agent-browser. `verb: snapshot` is
       * read-only; `click`/`hover`/`focus`/`dblclick` target a semantic ref
       * returned by a prior snapshot (e.g. "e36" for the Kill button).
       */
      kind: 'dashboard_action';
      verb: 'snapshot' | 'click' | 'hover' | 'focus' | 'dblclick';
      ref?: string;
      sessionId?: SessionId | null;
      reason?: string;
    } & { attestation?: ActionAttestation })
  | ({ kind: 'no_op'; reason: string } & { attestation?: ActionAttestation });

/** Outcome of running an action through classifier + safety rails. */
export type Classification =
  | { verdict: 'mechanics'; reason: string }
  | { verdict: 'content'; reason: string }
  | { verdict: 'blocked'; reason: string };

export interface DecisionRecord {
  ts: string;
  sessionId: SessionId | null;
  trigger: string;
  action: Action;
  classification: Classification;
  executed: boolean;
  notes?: string;
  /**
   * Free-form post-dispatch metadata. Used by dashboard_action to record
   * pre/post snapshot refs counts; future consumers (LLM replay, analytics)
   * can attach their own keys without a schema change.
   */
  metadata?: Record<string, unknown>;
}
