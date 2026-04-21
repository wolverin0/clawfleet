/**
 * Dashboard controller — encapsulates agent-browser for the orchestrator.
 *
 * Agent-browser gives the orchestrator DOM-level observation + action of the
 * running dashboard. This controller owns the lifecycle (warm-up Chrome at
 * boot, close on shutdown) and exposes a tight API the executor + HTTP layer
 * share:
 *
 *   - `snapshot()`       — current dashboard a11y tree + latency
 *   - `act(ref, verb)`   — click/hover/focus/dblclick a semantic ref
 *   - `warm()`           — called once at startup to amortise cold Chrome boot
 *   - `close()`          — tear down the named agent-browser session
 *
 * Opt-out: env `THEORCHESTRA_NO_DASHBOARD_SNAPSHOT=1` → controller becomes a
 * no-op stub. All callers check `enabled` before awaiting.
 */
import {
  snapshotDashboard,
  actOnRef,
  closeObserver,
  type AbObserverOptions,
  type AbSnapshotResult,
} from '../agent-browser-observer.js';

export interface DashboardSnapshotPayload {
  capturedAt: string;
  latencyMs: number;
  refsCount: number;
  refs: Record<string, { name: string; role: string }>;
  snapshotText: string | null;
  error?: string;
}

export type DashboardActVerb = 'click' | 'hover' | 'focus' | 'dblclick';

export interface DashboardControllerOptions {
  /** Base URL the backend is serving on (no trailing slash), e.g. http://127.0.0.1:4300 */
  dashboardBaseUrl: string;
  /** Auth token for the login form (optional if NO_AUTH=1). */
  token?: string | null;
  /** agent-browser session name so we don't collide with user sessions. */
  session?: string;
  /** Hard kill-switch. If false, all methods resolve to a no-op with `error: 'disabled'`. */
  enabled: boolean;
  /** Per-call timeout in ms for snapshot/act. Default 5s. */
  timeoutMs?: number;
}

export class DashboardController {
  private warmed = false;
  private warming: Promise<void> | null = null;
  private readonly abOpts: AbObserverOptions;
  /** Per-(verb, ref) cooldown timestamps (ms). */
  private readonly actCooldowns = new Map<string, number>();
  /** Default per-ref cooldown — 10 s. Tunable in tests. */
  public readonly actCooldownMs: number;

  constructor(private readonly opts: DashboardControllerOptions) {
    const url = new URL(opts.dashboardBaseUrl);
    if (opts.token) url.searchParams.set('token', opts.token);
    this.abOpts = {
      dashboardUrl: url.toString(),
      session: opts.session ?? 'theorchestra-orchestrator',
    };
    this.actCooldownMs = 10_000;
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** One-shot warm-up. Safe to call multiple times; only opens Chrome once. */
  async warm(): Promise<void> {
    if (!this.enabled || this.warmed) return;
    if (this.warming) return this.warming;
    this.warming = (async () => {
      try {
        // snapshotDashboard() calls `open` then `snapshot`; that's our warm.
        await snapshotDashboard(this.abOpts);
        this.warmed = true;
      } catch (err) {
        // Swallow — warming failure is not fatal; next real snapshot() will
        // retry and surface the error in its result.
        const m = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[dashboard-ctrl] warm failed: ${m.slice(0, 200)}\n`);
      } finally {
        this.warming = null;
      }
    })();
    return this.warming;
  }

  async snapshot(): Promise<DashboardSnapshotPayload> {
    if (!this.enabled) {
      return {
        capturedAt: new Date().toISOString(),
        latencyMs: 0,
        refsCount: 0,
        refs: {},
        snapshotText: null,
        error: 'disabled',
      };
    }
    try {
      const result: AbSnapshotResult = await snapshotDashboard(this.abOpts);
      this.warmed = true;
      // agent-browser@0.26 wraps the real payload inside
      // { success, data: { refs, snapshot } }. Unwrap defensively.
      const wrapper = result.tree as {
        success?: boolean;
        data?: {
          refs?: Record<string, { name: string; role: string }>;
          snapshot?: string;
        };
      };
      const refs = wrapper?.data?.refs ?? {};
      const snapshotText = typeof wrapper?.data?.snapshot === 'string' ? wrapper.data.snapshot : null;
      return {
        capturedAt: new Date().toISOString(),
        latencyMs: result.latencyMs,
        refsCount: Object.keys(refs).length,
        refs,
        snapshotText,
      };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return {
        capturedAt: new Date().toISOString(),
        latencyMs: 0,
        refsCount: 0,
        refs: {},
        snapshotText: null,
        error: m.slice(0, 500),
      };
    }
  }

  async act(ref: string, verb: DashboardActVerb): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.enabled) return { ok: false, error: 'disabled' };
    // Per-(verb, ref) cooldown prevents UI thrash when the advisor proposes
    // the same click repeatedly on e.g. a spinner-triggered state churn.
    const key = `${verb}|${ref}`;
    const now = Date.now();
    const last = this.actCooldowns.get(key);
    if (last !== undefined && now - last < this.actCooldownMs) {
      return {
        ok: false,
        error: `cooldown: ${key} fired ${Math.round((now - last) / 1000)}s ago (limit ${this.actCooldownMs / 1000}s)`,
      };
    }
    try {
      await actOnRef(ref, verb, this.abOpts);
      this.actCooldowns.set(key, now);
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return { ok: false, error: m.slice(0, 500) };
    }
  }

  async close(): Promise<void> {
    if (!this.enabled) return;
    await closeObserver(this.abOpts.session).catch(() => {});
    this.warmed = false;
  }
}

/** Build a controller from env + known port/token. Pure factory. */
export function buildDashboardController(params: {
  port: number;
  token: string | null;
  hostBind?: string;
}): DashboardController {
  const disabled = process.env.THEORCHESTRA_NO_DASHBOARD_SNAPSHOT === '1';
  const host = params.hostBind ?? '127.0.0.1';
  return new DashboardController({
    dashboardBaseUrl: `http://${host}:${params.port}`,
    token: params.token,
    enabled: !disabled,
  });
}
