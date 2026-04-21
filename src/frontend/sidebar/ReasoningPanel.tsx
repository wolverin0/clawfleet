import { useEffect, useState } from 'react';
import { authedFetch } from '../auth';

/**
 * PLAN-OF-TRUTH P4.2 — ReasoningPanel.
 *
 * Shows the last N orchestrator decisions that carry advisor attestation
 * (`by: 'llm-advisor'`). Polls /api/orchestrator/decisions every 5s. Hidden
 * entirely when the advisor is disabled so the panel never clutters the
 * sidebar for users who don't opt in.
 */

interface AdvisorStatus {
  enabled: boolean;
  provider: string;
  modelId: string;
  callsThisHour: number;
  cooldownsActive: number;
}

interface Attestation {
  by: string;
  reasoning: string;
  model: string;
  latencyMs: number;
}

interface Decision {
  ts: string;
  sessionId: string | null;
  trigger: string;
  action: {
    kind: string;
    verb?: string;
    ref?: string;
    reason?: string;
    attestation?: Attestation;
  };
  classification: { verdict: string; reason: string };
  executed: boolean;
  metadata?: Record<string, unknown>;
}

export function ReasoningPanel() {
  const [status, setStatus] = useState<AdvisorStatus | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function pull(): Promise<void> {
      try {
        const [sRes, dRes] = await Promise.all([
          authedFetch('/api/orchestrator/advisor'),
          authedFetch('/api/orchestrator/decisions?limit=40'),
        ]);
        if (!alive) return;
        if (sRes.ok) setStatus((await sRes.json()) as AdvisorStatus);
        if (dRes.ok) {
          const body = (await dRes.json()) as { decisions: Decision[] };
          setDecisions(body.decisions);
        }
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }
    pull();
    const t = setInterval(pull, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (error) {
    return <div className="rp-error">reasoning panel: {error}</div>;
  }
  if (!status) return <div className="rp-loading">loading advisor status…</div>;
  if (!status.enabled) {
    return (
      <div className="rp-disabled">
        <p>
          LLM advisor is off. Set <code>THEORCHESTRA_LLM_ADVISOR=1</code> and
          provide <code>ANTHROPIC_API_KEY</code> or put <code>claude</code> on
          PATH to enable autonomous subjective reasoning.
        </p>
      </div>
    );
  }

  const attested = decisions.filter((d) => d.action.attestation?.by === 'llm-advisor');

  return (
    <div className="rp-body">
      <div className="rp-status">
        <span className="rp-pill">{status.provider}</span>
        <span className="rp-pill">{status.modelId}</span>
        <span className="rp-pill">{status.callsThisHour}/hr</span>
        <span className="rp-pill">{status.cooldownsActive} cool</span>
      </div>
      {attested.length === 0 ? (
        <div className="rp-empty">No advisor-attested decisions yet.</div>
      ) : (
        <ul className="rp-list">
          {attested
            .slice(-20)
            .reverse()
            .map((d, idx) => (
              <li key={`${d.ts}-${idx}`} className="rp-item">
                <div className="rp-row-head">
                  <span className="rp-ts">{d.ts.slice(11, 19)}</span>
                  <span className="rp-kind">{d.action.kind}</span>
                  {d.action.verb && <span className="rp-pill small">{d.action.verb}</span>}
                  {d.action.ref && <span className="rp-pill small">{d.action.ref}</span>}
                  <span className={`rp-exec ${d.executed ? 'ok' : 'no'}`}>
                    {d.executed ? '✓' : '✗'}
                  </span>
                </div>
                <div className="rp-reasoning">{d.action.attestation?.reasoning}</div>
                {d.metadata && (
                  <div className="rp-meta">
                    {typeof d.metadata.pre_refs_count === 'number' && (
                      <span>pre:{d.metadata.pre_refs_count as number}</span>
                    )}
                    {typeof d.metadata.post_refs_count === 'number' && (
                      <span>post:{d.metadata.post_refs_count as number}</span>
                    )}
                    {typeof d.metadata.act_error === 'string' && (
                      <span className="rp-meta-err">err: {d.metadata.act_error as string}</span>
                    )}
                  </div>
                )}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
