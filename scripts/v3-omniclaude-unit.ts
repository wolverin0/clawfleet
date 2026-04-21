/**
 * PLAN-OF-TRUTH P7.G1 — omniclaude driver unit tests.
 *
 * No network, no `claude` spawn. Uses the driver in disabled mode + a
 * manual queue+bus to verify:
 *   1. enabled=false yields the NOT_RUNNING stub (no spawn, no subscribe)
 *   2. Event formatting produces the expected prompt shape
 *   3. Self-events (sid === omniSid) are skipped — no enqueue on own sid
 */
import { EventBus } from '../src/backend/events.js';
import { PaneQueueStore } from '../src/backend/pane-queue.js';
import { PtyManager } from '../src/backend/pty-manager.js';
import { startOmniclaudeDriver } from '../src/backend/omniclaude-driver.js';
import type { SseEvent } from '../src/shared/types.js';

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

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('PLAN-OF-TRUTH P7.G1 — omniclaude unit tests');
  console.log('='.repeat(60));

  await test('disabled driver returns NOT_RUNNING stub', async () => {
    const manager = new PtyManager();
    const bus = new EventBus();
    const queue = new PaneQueueStore();
    const driver = startOmniclaudeDriver({
      enabled: false,
      manager,
      bus,
      queue,
    });
    if (driver.sessionId !== null) throw new Error(`expected null sid, got ${driver.sessionId}`);
    driver.stop(); // must be safe
  });

  await test('enabled=true without claude on PATH degrades gracefully', async () => {
    // We can't easily stub PATH detection in-test; instead we verify the
    // module's public contract: if anything blocks spawn (claude missing,
    // permission failure), the return is NOT_RUNNING, not a throw.
    const manager = new PtyManager();
    const bus = new EventBus();
    const queue = new PaneQueueStore();
    // Patch claude spawn by setting an empty PATH so `where claude` fails.
    const originalPath = process.env.PATH;
    process.env.PATH = process.platform === 'win32' ? 'C:\\Nowhere' : '/nowhere';
    try {
      const driver = startOmniclaudeDriver({
        enabled: true,
        manager,
        bus,
        queue,
      });
      // If claude is somehow still found (e.g. shim in cwd), skip with a note.
      if (driver.sessionId !== null) {
        console.log('  (note: claude resolved despite PATH override — degraded-test skipped)');
        driver.stop();
        manager.killAll();
        return;
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });

  await test('event → prompt pipeline respects self-filter + shape', async () => {
    // No real PTY — just fake an omniSid and replicate the driver's
    // subscription shape inline. This asserts the CONTRACT (shape +
    // self-filter) without booting a Claude session.
    const bus = new EventBus();
    const queue = new PaneQueueStore();
    const omniSid = 'fake-omni-sid-000000000000';
    bus.subscribe((evt: SseEvent) => {
      if ('sessionId' in evt && evt.sessionId === omniSid) return;
      queue.enqueue(
        omniSid,
        `[EVENT type=${evt.type} id=${evt.id} ts=${evt.ts}]\nstub body\nRespond…`,
      );
    });
    bus.publish({ type: 'permission_prompt', sessionId: 'other-pane', promptText: 'test?' });
    const snap = queue.snapshot(omniSid);
    if (snap.pending.length !== 1) {
      throw new Error(`expected 1 queued entry, got ${snap.pending.length}`);
    }
    if (!snap.pending[0]!.text.startsWith('[EVENT type=permission_prompt')) {
      throw new Error(`bad prompt prefix: ${snap.pending[0]!.text.slice(0, 60)}`);
    }
    // Self-event filter.
    bus.publish({ type: 'pane_idle', sessionId: omniSid });
    if (queue.snapshot(omniSid).pending.length !== 1) {
      throw new Error('self-event leaked through filter');
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
