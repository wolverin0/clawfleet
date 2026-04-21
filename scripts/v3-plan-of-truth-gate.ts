/**
 * PLAN-OF-TRUTH P5.3 — final aggregator gate.
 *
 * Runs, in order:
 *   1. Baseline gate                    scripts/v3-baseline-gate.ts
 *   2. LLM advisor unit tests           scripts/v3-llm-advisor-unit.ts
 *   3. LLM advisor e2e gate             scripts/v3-llm-advisor-gate.ts
 *   4. Dashboard-action unit tests      scripts/v3-dashboard-action-unit.ts
 *   5. Dashboard-action e2e gate        scripts/v3-dashboard-action-gate.ts
 *   6. Reasoning-panel gate             scripts/v3-reasoning-panel-gate.ts
 *
 * Non-zero exit on any failure. Prints a one-line summary at the end.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

interface Step {
  label: string;
  script: string;
}

const STEPS: Step[] = [
  { label: 'P1 baseline', script: 'scripts/v3-baseline-gate.ts' },
  { label: 'P2.C1 advisor unit', script: 'scripts/v3-llm-advisor-unit.ts' },
  { label: 'P2.C2 advisor e2e', script: 'scripts/v3-llm-advisor-gate.ts' },
  { label: 'P3.A1 dashboard-action unit', script: 'scripts/v3-dashboard-action-unit.ts' },
  { label: 'P3.A2 dashboard-action e2e', script: 'scripts/v3-dashboard-action-gate.ts' },
  { label: 'P4.A reasoning panel', script: 'scripts/v3-reasoning-panel-gate.ts' },
];

async function runOne(step: Step): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, step.script], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d.toString()));
    child.stderr.on('data', (d) => (output += d.toString()));
    child.on('exit', (code) => resolve({ ok: code === 0, output }));
  });
}

async function main(): Promise<void> {
  console.log('=' .repeat(60));
  console.log('PLAN-OF-TRUTH — final aggregator gate');
  console.log('=' .repeat(60));

  const results: { step: Step; ok: boolean }[] = [];
  for (const step of STEPS) {
    process.stdout.write(`\n▶ ${step.label} (${step.script}) … `);
    const t0 = Date.now();
    const { ok, output } = await runOne(step);
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    if (ok) {
      console.log(`PASS (${s}s)`);
    } else {
      console.log(`FAIL (${s}s)`);
      console.log('---captured output---');
      console.log(output.slice(-2000));
      console.log('---end---');
    }
    results.push({ step, ok });
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log('\n' + '='.repeat(60));
  console.log(`FINAL: ${passed}/${total} steps green`);
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`  ${r.ok ? '[PASS]' : '[FAIL]'} ${r.step.label}`);
  }

  if (passed !== total) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
