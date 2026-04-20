import { useEffect, useMemo, useState } from 'react';
import { useSseEvents, type SseEventAny } from '../useSseEvents';
import { authedFetch } from '../auth';

/**
 * Handoff UX tied to SSE `ctx_threshold` events:
 *   - 40% crossing → dismissible toast ("suggest a handoff")
 *   - 60% crossing → enforce modal ("critical — run auto-handoff")
 *   - 70% crossing → info toast ("auto-handoff already running")
 *
 * Legacy 30/50 events are coerced to 40/60 so mid-flight SSE streams
 * from older backends keep working during rollout.
 */

type CrossedKind = 'suggest' | 'critical' | 'automatic';
interface ThresholdAlert {
  sessionId: string;
  percent: number;
  crossed: 40 | 60 | 70;
  kind: CrossedKind;
  id: number;
  ts: string;
  dismissed?: boolean;
}

function classifyCrossed(raw: unknown): { crossed: 40 | 60 | 70; kind: CrossedKind } {
  const n = Number(raw);
  if (n >= 70) return { crossed: 70, kind: 'automatic' };
  if (n >= 60 || n === 50) return { crossed: 60, kind: 'critical' };
  return { crossed: 40, kind: 'suggest' };
}

export function HandoffAlerts() {
  const events = useSseEvents();
  const [dismissed, setDismissed] = useState<Record<string, true>>({});
  const [actioning, setActioning] = useState<Record<string, boolean>>({});

  // Pick the most recent ctx_threshold event per (session, crossed).
  const alerts = useMemo<ThresholdAlert[]>(() => {
    const map = new Map<string, ThresholdAlert>();
    for (const ev of events) {
      if (ev.type !== 'ctx_threshold') continue;
      const sid = String(ev.sessionId ?? '');
      const { crossed, kind } = classifyCrossed(ev.crossed);
      const key = `${sid}:${crossed}`;
      const next: ThresholdAlert = {
        sessionId: sid,
        percent: Number(ev.percent ?? 0),
        crossed,
        kind,
        id: Number(ev.id ?? 0),
        ts: String(ev.ts ?? ''),
      };
      const prev = map.get(key);
      if (!prev || prev.id < next.id) map.set(key, next);
    }
    return Array.from(map.values()).filter((a) => !dismissed[`${a.sessionId}:${a.crossed}:${a.id}`]);
  }, [events, dismissed]);

  // Auto-clear stale dismissals from memory as new events arrive so the
  // same alert can re-fire next time the buffer rolls.
  useEffect(() => {
    // No-op intentionally: dismiss state keys include event id, so new
    // events naturally bypass old dismissals.
  }, []);

  const dismiss = (a: ThresholdAlert): void => {
    const key = `${a.sessionId}:${a.crossed}:${a.id}`;
    setDismissed((prev) => ({ ...prev, [key]: true }));
  };

  const triggerHandoff = async (a: ThresholdAlert, force: boolean): Promise<void> => {
    const key = `${a.sessionId}:${a.crossed}:${a.id}`;
    setActioning((p) => ({ ...p, [key]: true }));
    try {
      await authedFetch(`/api/sessions/${encodeURIComponent(a.sessionId)}/auto-handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      dismiss(a);
    } catch {
      /* leave the alert visible if it failed */
    } finally {
      setActioning((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    }
  };

  const toasts = alerts.filter((a) => a.kind === 'suggest' || a.kind === 'automatic');
  const modals = alerts.filter((a) => a.kind === 'critical');

  return (
    <>
      {/* 30% toasts — stacked bottom-left, dismissible */}
      {toasts.length > 0 && (
        <div className="handoff-toast-stack" aria-live="polite">
          {toasts.slice(0, 3).map((a) => {
            const key = `${a.sessionId}:${a.crossed}:${a.id}`;
            return (
              <div key={key} className="handoff-toast">
                <div className="handoff-toast-head">
                  <span className="handoff-badge">Ctx {a.percent.toFixed(0)}%</span>
                  <span className="handoff-toast-body">
                    {a.kind === 'automatic'
                      ? `pane ${a.sessionId.slice(0, 8)}… at ${a.percent.toFixed(0)}% — auto-handoff triggered (readiness check sent to pane).`
                      : `pane ${a.sessionId.slice(0, 8)}… is approaching ctx limit — consider a handoff soon.`}
                  </span>
                  <button
                    type="button"
                    className="handoff-toast-dismiss"
                    onClick={() => dismiss(a)}
                    aria-label="Dismiss"
                  >
                    ✕
                  </button>
                </div>
                <div className="handoff-toast-actions">
                  <button
                    type="button"
                    onClick={() => void triggerHandoff(a, false)}
                    disabled={!!actioning[key]}
                  >
                    {actioning[key] ? 'Running…' : 'Run handoff now'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 50% modal — blocking, full-screen backdrop */}
      {modals.length > 0 &&
        (() => {
          const a = modals[0]!;
          const key = `${a.sessionId}:${a.crossed}:${a.id}`;
          return (
            <div className="handoff-modal-backdrop" role="dialog" aria-modal="true">
              <div className="handoff-modal">
                <div className="handoff-modal-head">
                  <span className="handoff-badge handoff-badge-danger">
                    Ctx {a.percent.toFixed(0)}% — enforce
                  </span>
                  <span>Pane {a.sessionId.slice(0, 8)}…</span>
                </div>
                <div className="handoff-modal-body">
                  This pane has crossed the 60% ctx threshold (critical). Continuing risks
                  losing conversation state to auto-compaction. If you are mid-task, reply
                  READY/NOT_READY in the pane — NOT_READY lets you finish the current step.
                  Otherwise: trigger an auto-handoff (writes a handoff file, clears the pane,
                  and resumes from the handoff). At 70% the dashboard will trigger
                  auto-handoff itself.
                </div>
                <div className="handoff-modal-actions">
                  <button
                    type="button"
                    className="handoff-modal-primary"
                    onClick={() => void triggerHandoff(a, false)}
                    disabled={!!actioning[key]}
                  >
                    {actioning[key] ? 'Running auto-handoff…' : 'Run auto-handoff (readiness check)'}
                  </button>
                  <button
                    type="button"
                    className="handoff-modal-force"
                    onClick={() => void triggerHandoff(a, true)}
                    disabled={!!actioning[key]}
                  >
                    Force-handoff now
                  </button>
                  <button
                    type="button"
                    className="handoff-modal-dismiss"
                    onClick={() => dismiss(a)}
                  >
                    Dismiss (will re-fire)
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </>
  );
}
