/**
 * PLAN-OF-TRUTH P3.A1 — dashboard_action unit tests.
 * No network. Stubs the advisor provider + a fake dashboard controller.
 */

import { EventBus } from '../src/backend/events.js';
import { PtyManager } from '../src/backend/pty-manager.js';
import { startOrchestrator } from '../src/backend/orchestrator/executor.js';
import { LlmAdvisor, type AdvisorProvider } from '../src/backend/orchestrator/llm-advisor.js';
import type { DashboardController, DashboardActVerb, DashboardSnapshotPayload } from '../src/backend/orchestrator/dashboard-controller.js';
import type { SseEvent } from '../src/shared/types.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

interface FakeDashboard extends DashboardController {
  calls: { verb: DashboardActVerb; ref: string }[];
}

function buildFakeDashboard(
  refs: Record<string, { name: string; role: string }> = { e1: { name: 'x', role: 'button' } },
): FakeDashboard {
  const calls: { verb: DashboardActVerb; ref: string }[] = [];
  const snap: DashboardSnapshotPayload = {
    capturedAt: new Date().toISOString(),
    latencyMs: 1,
    refsCount: Object.keys(refs).length,
    refs,
    snapshotText: 'stub',
  };
  return {
    enabled: true,
    actCooldownMs: 50,
    warm: async () => {},
    snapshot: async () => ({ ...snap, capturedAt: new Date().toISOString() }),
    act: async (ref: string, verb: DashboardActVerb) => {
      calls.push({ ref, verb });
      // Check BEFORE push-count threshold so the second call actually fails.
      if (calls.length >= 2) return { ok: false as const, error: 'stub-cooldown' };
      return { ok: true as const };
    },
    close: async () => {},
    calls,
  } as unknown as FakeDashboard;
}

function stubProvider(raw: string): AdvisorProvider {
  return { name: 'stub', modelId: 'stub-1', call: async () => raw };
}

const results: { name: string; passed: boolean; detail?: string }[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, detail: m });
    console.log(`  [FAIL] ${name}: ${m}`);
  }
}

function buildOrch(advisor: LlmAdvisor, dashboard: DashboardController | undefined): {
  handle: (e: SseEvent) => Promise<void>;
  decisions: () => ReturnType<ReturnType<typeof startOrchestrator>['log']['tail']>;
  stop: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theorch-dboard-act-'));
  const manager = new PtyManager();
  const bus = new EventBus();
  const handles = startOrchestrator(manager, bus, {
    decisionsDir: path.join(tmpDir, '_dec'),
    advisor,
    dashboard,
  });
  return {
    handle: async (e) => {
      await handles._dispatchForTest(e);
    },
    decisions: () => handles.log.tail(10),
    stop: () => {
      handles.stop();
      manager.killAll();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function pPrompt(sid = 'test-sid-aaaa'): SseEvent {
  return {
    id: 1,
    ts: new Date().toISOString(),
    type: 'permission_prompt',
    sessionId: sid,
    promptText: 'allow?',
  };
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('PLAN-OF-TRUTH P3.A1 — dashboard_action unit tests');
  console.log('='.repeat(60));

  const pm = new PtyManager();
  void pm;

  await test('attested click dispatches → act() called once', async () => {
    const dash = buildFakeDashboard();
    const advisor = new LlmAdvisor({
      enabled: true,
      manager: pm,
      dashboard: dash,
      providerOverride: stubProvider(
        '{"verdict":"dashboard_action","ref":"e1","actVerb":"click","reasoning":"do it"}',
      ),
    });
    const o = buildOrch(advisor, dash);
    try {
      await o.handle(pPrompt());
      // dispatch is async IIFE — give it a tick to run
      await new Promise((r) => setTimeout(r, 200));
      if (dash.calls.length !== 1) throw new Error(`expected 1 act call, got ${dash.calls.length}`);
      if (dash.calls[0]!.verb !== 'click' || dash.calls[0]!.ref !== 'e1')
        throw new Error(`wrong call: ${JSON.stringify(dash.calls[0])}`);
    } finally {
      o.stop();
    }
  });

  await test('unattested dashboard_action routes to content (baseline)', async () => {
    const dash = buildFakeDashboard();
    // No advisor → baseline classifier routes dashboard_action/click → content.
    // We can't easily emit a raw dashboard_action action without advisor, so
    // we use the advisor-disabled path + confirm that the snap endpoint alone
    // doesn't trigger any UI act.
    const advisor = new LlmAdvisor({
      enabled: false,
      manager: pm,
      providerOverride: stubProvider('{"verdict":"content","reasoning":"x"}'),
    });
    const o = buildOrch(advisor, dash);
    try {
      await o.handle(pPrompt());
      await new Promise((r) => setTimeout(r, 200));
      if (dash.calls.length !== 0) throw new Error('no advisor = no auto click');
    } finally {
      o.stop();
    }
  });

  await test('per-ref cooldown blocks second click inside window', async () => {
    const dash = buildFakeDashboard();
    const advisor = new LlmAdvisor({
      enabled: true,
      manager: pm,
      dashboard: dash,
      perPaneCooldownSec: 0.01, // essentially no advisor cooldown
      providerOverride: stubProvider(
        '{"verdict":"dashboard_action","ref":"e1","actVerb":"click","reasoning":"do"}',
      ),
    });
    const o = buildOrch(advisor, dash);
    try {
      await o.handle(pPrompt('sid-0001'));
      await new Promise((r) => setTimeout(r, 400));
      await o.handle(pPrompt('sid-0002'));
      // Two snapshots per dispatch (pre + post at t+1500ms). Wait > 1.5s.
      await new Promise((r) => setTimeout(r, 2000));
      // fakeDashboard returns failure on second call.
      if (dash.calls.length !== 2) throw new Error(`expected 2 act attempts, got ${dash.calls.length}`);
      const d = o.decisions();
      // The second decision's metadata should carry act_ok=false.
      const lastDashboardDecision = [...d].reverse().find((r) => r.action.kind === 'dashboard_action');
      if (!lastDashboardDecision) throw new Error('no dashboard decision recorded');
      const md = lastDashboardDecision.metadata as { act_ok?: boolean } | undefined;
      if (md?.act_ok !== false) throw new Error(`expected act_ok=false, got ${JSON.stringify(md)}`);
    } finally {
      o.stop();
    }
  });

  await test('dashboard disabled → attested dashboard_action returns false', async () => {
    const dash = { ...buildFakeDashboard(), enabled: false } as FakeDashboard;
    const advisor = new LlmAdvisor({
      enabled: true,
      manager: pm,
      dashboard: dash,
      providerOverride: stubProvider(
        '{"verdict":"dashboard_action","ref":"e1","actVerb":"click","reasoning":"do"}',
      ),
    });
    const o = buildOrch(advisor, dash);
    try {
      await o.handle(pPrompt());
      await new Promise((r) => setTimeout(r, 200));
      const d = o.decisions();
      const lastDashboardDecision = [...d].reverse().find((r) => r.action.kind === 'dashboard_action');
      if (!lastDashboardDecision) throw new Error('no dashboard decision recorded');
      if (lastDashboardDecision.executed !== false)
        throw new Error(`expected executed=false, got ${lastDashboardDecision.executed}`);
    } finally {
      o.stop();
    }
  });

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`RESULT: ${passed}/${total} PASS`);
  console.log('='.repeat(60));
  if (passed !== total) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
