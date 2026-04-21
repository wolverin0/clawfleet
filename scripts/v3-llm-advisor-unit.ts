/**
 * PLAN-OF-TRUTH P2.C1 — LLM advisor unit tests.
 *
 * No network, no real providers. Uses `providerOverride` to inject a stub
 * into the advisor and exercises every branch of `advise()` + the
 * executor+classifier interaction via `_dispatchForTest`.
 */

import { EventBus } from '../src/backend/events.js';
import { PtyManager } from '../src/backend/pty-manager.js';
import { startOrchestrator } from '../src/backend/orchestrator/executor.js';
import { LlmAdvisor, type AdvisorProvider } from '../src/backend/orchestrator/llm-advisor.js';
import type { DashboardController, DashboardSnapshotPayload } from '../src/backend/orchestrator/dashboard-controller.js';
import type { SseEvent } from '../src/shared/types.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

function fakeDashboard(refs: Record<string, { name: string; role: string }> = {}): DashboardController {
  const snap: DashboardSnapshotPayload = {
    capturedAt: new Date().toISOString(),
    latencyMs: 1,
    refsCount: Object.keys(refs).length,
    refs,
    snapshotText: 'stub',
  };
  return {
    enabled: true,
    warm: async () => {},
    snapshot: async () => snap,
    act: async () => ({ ok: true }),
    close: async () => {},
  } as unknown as DashboardController;
}

function stubProvider(rawResponse: string): AdvisorProvider {
  return {
    name: 'stub',
    modelId: 'stub-1',
    call: async () => rawResponse,
  };
}

function throwingProvider(): AdvisorProvider {
  return {
    name: 'stub-throw',
    modelId: 'stub-1',
    call: async () => {
      throw new Error('stub-network-error');
    },
  };
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

function buildOrchestrator(advisor: LlmAdvisor | undefined): {
  handle: (e: SseEvent) => Promise<void>;
  chatCount: () => number;
  latestAction: () => string;
  decisionTail: (n: number) => { action: { kind: string; attestation?: unknown }; classification: { verdict: string } }[];
  stop: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theorch-advtest-'));
  const manager = new PtyManager();
  const bus = new EventBus();
  // No real dashboard controller on the executor — we only use one inside
  // the advisor stub path. This way we test the full orchestrator flow
  // without agent-browser boot.
  const handles = startOrchestrator(manager, bus, {
    decisionsDir: path.join(tmpDir, '_dec'),
    advisor,
  });
  return {
    handle: async (e) => {
      await handles._dispatchForTest(e);
    },
    chatCount: () => handles.chat.list().filter((m) => m.from === 'orchestrator').length,
    latestAction: () => {
      const tail = handles.log.tail(1);
      return tail.length > 0 ? tail[0]!.action.kind : 'none';
    },
    decisionTail: (n) => handles.log.tail(n) as never,
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

function permissionPromptEvent(): SseEvent {
  return {
    id: 1,
    ts: new Date().toISOString(),
    type: 'permission_prompt',
    sessionId: 'test-session-0001',
    promptText: 'Allow file edit?',
  };
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('PLAN-OF-TRUTH P2.C1 — llm-advisor unit tests');
  console.log('='.repeat(60));

  const pm = new PtyManager();
  void pm;

  // 1. stub provider returns mechanic → permission escalation gets endorsed but stays content
  //    since the proposed action was escalate_to_user. Verify: attestation attached.
  await test('mechanic verdict keeps proposed content + attaches attestation', async () => {
    const advisor = new LlmAdvisor({
      enabled: true,
      manager: pm,
      providerOverride: stubProvider('{"verdict":"mechanic","reasoning":"ok by me"}'),
    });
    const o = buildOrchestrator(advisor);
    try {
      await o.handle(permissionPromptEvent());
      const tail = o.decisionTail(1);
      if (tail.length !== 1) throw new Error(`expected 1 decision, got ${tail.length}`);
      const d = tail[0]!;
      if (d.action.kind !== 'escalate_to_user') throw new Error(`expected escalate_to_user, got ${d.action.kind}`);
      if (!d.action.attestation) throw new Error('expected attestation attached');
    } finally {
      o.stop();
    }
  });

  // 2. dashboard_action verdict with valid ref → recorded as dashboard_action
  await test('dashboard_action verdict produces dashboard_action decision', async () => {
    const advisor = new LlmAdvisor({
      enabled: true,
      manager: pm,
      dashboard: fakeDashboard({ e7: { name: 'Kill', role: 'button' } }),
      providerOverride: stubProvider(
        '{"verdict":"dashboard_action","ref":"e7","actVerb":"click","reasoning":"kill runaway pane"}',
      ),
    });
    const o = buildOrchestrator(advisor);
    try {
      await o.handle(permissionPromptEvent());
      const d = o.decisionTail(1)[0]!;
      if (d.action.kind !== 'dashboard_action') throw new Error(`expected dashboard_action, got ${d.action.kind}`);
      if (d.classification.verdict !== 'mechanics') throw new Error(`expected mechanics, got ${d.classification.verdict}`);
    } finally {
      o.stop();
    }
  });

  // 3. content verdict → proposed escalate stands; chat.ask fires
  await test('content verdict fires chat.ask', async () => {
    const advisor = new LlmAdvisor({
      enabled: true,
      manager: pm,
      providerOverride: stubProvider('{"verdict":"content","reasoning":"need user"}'),
    });
    const o = buildOrchestrator(advisor);
    try {
      await o.handle(permissionPromptEvent());
      if (o.chatCount() < 1) throw new Error('expected a chat.ask orchestrator msg');
    } finally {
      o.stop();
    }
  });

  // 4. throwing provider → falls back to proposed (content/escalate)
  await test('provider error falls back to rule-engine verdict', async () => {
    const advisor = new LlmAdvisor({
      enabled: true,
      manager: pm,
      providerOverride: throwingProvider(),
    });
    const o = buildOrchestrator(advisor);
    try {
      await o.handle(permissionPromptEvent());
      const d = o.decisionTail(1)[0]!;
      if (d.action.kind !== 'escalate_to_user') throw new Error(`expected escalate_to_user fallback, got ${d.action.kind}`);
      if (d.action.attestation) throw new Error('expected no attestation on fallback');
    } finally {
      o.stop();
    }
  });

  // 5. malformed JSON → no_op (advisor returns no_op verdict which is also a fallback)
  await test('malformed JSON from provider becomes content fallback', async () => {
    const advisor = new LlmAdvisor({
      enabled: true,
      manager: pm,
      providerOverride: stubProvider('this is not json at all'),
    });
    const o = buildOrchestrator(advisor);
    try {
      await o.handle(permissionPromptEvent());
      const d = o.decisionTail(1)[0]!;
      // parseVerdict returns no_op with error; maybeReviseWithAdvisor sees
      // `error` and falls back to the proposed escalate_to_user.
      if (d.action.kind !== 'escalate_to_user') {
        throw new Error(`expected fallback escalate_to_user, got ${d.action.kind}`);
      }
    } finally {
      o.stop();
    }
  });

  // 6. cost cap: perPaneCooldownMs=5_000 (via ctor), second call within 5s is rejected
  await test('per-pane cooldown rejects second call in window', async () => {
    const advisor = new LlmAdvisor({
      enabled: true,
      manager: pm,
      providerOverride: stubProvider('{"verdict":"content","reasoning":"meh"}'),
      perPaneCooldownSec: 30,
    });
    const o = buildOrchestrator(advisor);
    try {
      await o.handle(permissionPromptEvent());
      await o.handle(permissionPromptEvent());
      const tail = o.decisionTail(2);
      if (tail.length !== 2) throw new Error(`expected 2 decisions, got ${tail.length}`);
      // Both land, but second one should have no advisor-provided attestation
      // (the advisor short-circuited with cooldown + error).
      // Both are "content fallback" so attestation should be absent on both
      // (since verdict='content' + error branch returns proposed as-is).
      // We assert the advisor stats show only 1 call this hour:
      if (advisor.stats.callsThisHour !== 1) {
        throw new Error(`expected 1 advisor call this hour, got ${advisor.stats.callsThisHour}`);
      }
    } finally {
      o.stop();
    }
  });

  // 7. advisor disabled → no advisor calls, baseline classifier takes over
  await test('disabled advisor is bypass — no calls, escalate lands', async () => {
    const advisor = new LlmAdvisor({
      enabled: false,
      manager: pm,
      providerOverride: stubProvider('{"verdict":"content","reasoning":"x"}'),
    });
    const o = buildOrchestrator(advisor);
    try {
      await o.handle(permissionPromptEvent());
      if (advisor.stats.callsThisHour !== 0) throw new Error('disabled advisor must not call');
      if (o.chatCount() < 1) throw new Error('expected baseline content/escalate path to fire');
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
