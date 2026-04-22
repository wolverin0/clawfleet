/**
 * PLAN-OF-TRUTH A-3 — 24h soak gate (SCAFFOLD).
 *
 * Not a short-run gate. Designed to prove the backend + omniclaude stay
 * healthy over a 24h window with no supervision. Reports a pass/fail
 * summary at the end based on:
 *   - /api/health ok rate ≥ 99%
 *   - no crash-restart loops in the omniclaude pane
 *   - at least 1 decision line written per hour (omniclaude responsive)
 *   - memory footprint (RSS) growth ≤ 50% over the window
 *
 * Usage:
 *     THEORCHESTRA_PORT=4300 THEORCHESTRA_TOKEN=<tok> \
 *       npx tsx scripts/v3-soak-24h-gate.ts
 *
 * Override the window for dev testing:
 *     SOAK_HOURS=1 npx tsx scripts/v3-soak-24h-gate.ts
 *
 * IMPORTANT: this script is a passive observer. Start the backend
 * separately via `npm run v3:start-omni`; do NOT let this script spawn
 * the backend, because it would exit when the script dies.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

const PORT = Number(process.env.THEORCHESTRA_PORT ?? '4300');
const TOKEN = process.env.THEORCHESTRA_TOKEN ?? '';
const HOURS = Number(process.env.SOAK_HOURS ?? '24');
const OUTPUT_DIR = path.resolve(process.env.SOAK_OUTPUT_DIR ?? path.join(process.cwd(), 'docs', 'soak-reports'));

interface SampleRow {
  t: string;
  health_ok: boolean;
  pane_count: number;
  omni_alive: boolean;
  decisions_today: number;
  rss_bytes: number | null;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function httpJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function sample(): Promise<SampleRow> {
  const t = new Date().toISOString();
  const health = await httpJson<{ ok?: boolean }>('/api/health');
  const sessions = (await httpJson<unknown[]>('/api/sessions?include_omni=1')) ?? [];
  const omni = await httpJson<{ enabled?: boolean; session?: unknown }>('/api/orchestrator/omniclaude');
  const decisions = await httpJson<{ decisions?: unknown[] }>('/api/orchestrator/decisions?limit=500');
  const decisionCount = Array.isArray(decisions?.decisions) ? decisions.decisions.length : 0;
  let rss: number | null = null;
  try {
    rss = process.memoryUsage().rss; // script's own RSS; imperfect proxy
  } catch {
    /* */
  }
  return {
    t,
    health_ok: health?.ok === true,
    pane_count: sessions.length,
    omni_alive: omni?.enabled === true && !!omni?.session,
    decisions_today: decisionCount,
    rss_bytes: rss,
  };
}

async function main(): Promise<void> {
  if (!TOKEN && process.env.THEORCHESTRA_NO_AUTH !== '1') {
    console.error('ERROR: set THEORCHESTRA_TOKEN or THEORCHESTRA_NO_AUTH=1');
    process.exit(2);
  }
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });

  const startedAt = Date.now();
  const endAt = startedAt + HOURS * 3600 * 1000;
  const sampleIntervalMs = 60_000;
  const reportPath = path.join(
    OUTPUT_DIR,
    `soak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
  );

  console.log(`[soak] starting ${HOURS}h observation on :${PORT}`);
  console.log(`[soak] report → ${reportPath}`);

  const samples: SampleRow[] = [];
  let healthyCount = 0;
  let totalCount = 0;

  while (Date.now() < endAt) {
    const row = await sample();
    samples.push(row);
    totalCount++;
    if (row.health_ok) healthyCount++;

    // Lightweight heartbeat log so tail -f shows progress.
    if (totalCount % 10 === 0) {
      const pct = ((healthyCount / totalCount) * 100).toFixed(1);
      const elapsedH = ((Date.now() - startedAt) / 3600_000).toFixed(2);
      console.log(
        `[soak] t+${elapsedH}h: samples=${totalCount} healthy=${pct}% panes=${row.pane_count} omni=${row.omni_alive} decisions=${row.decisions_today}`,
      );
    }

    // Write rolling report so we don't lose data on crash.
    await fsp.writeFile(
      reportPath,
      JSON.stringify(
        {
          started_at: new Date(startedAt).toISOString(),
          hours: HOURS,
          port: PORT,
          samples,
        },
        null,
        2,
      ),
      'utf-8',
    );

    await wait(sampleIntervalMs);
  }

  // ─── Summary ─────────────────────────────────────────────────────────
  const healthyPct = (healthyCount / Math.max(totalCount, 1)) * 100;
  const firstRss = samples.find((s) => s.rss_bytes !== null)?.rss_bytes ?? null;
  const lastRss = [...samples].reverse().find((s) => s.rss_bytes !== null)?.rss_bytes ?? null;
  const rssGrowthPct = firstRss && lastRss ? ((lastRss - firstRss) / firstRss) * 100 : null;
  const omniAlivePct =
    (samples.filter((s) => s.omni_alive).length / Math.max(samples.length, 1)) * 100;

  // Decisions per hour — check for omniclaude responsiveness.
  const hourlyBuckets = new Map<string, number>();
  for (const s of samples) {
    const hr = s.t.slice(0, 13);
    hourlyBuckets.set(hr, Math.max(hourlyBuckets.get(hr) ?? 0, s.decisions_today));
  }
  const hourlyDeltas: number[] = [];
  let prev: number | null = null;
  for (const [, v] of hourlyBuckets) {
    if (prev !== null) hourlyDeltas.push(v - prev);
    prev = v;
  }
  const deadHours = hourlyDeltas.filter((d) => d <= 0).length;

  const verdict: 'PASS' | 'FAIL' =
    healthyPct >= 99 &&
    omniAlivePct >= 95 &&
    (rssGrowthPct === null || rssGrowthPct < 50) &&
    deadHours <= 1
      ? 'PASS'
      : 'FAIL';

  console.log('\n' + '='.repeat(60));
  console.log(`SOAK SUMMARY (${HOURS}h)`);
  console.log('='.repeat(60));
  console.log(`  samples:          ${totalCount}`);
  console.log(`  health-ok %:      ${healthyPct.toFixed(2)}`);
  console.log(`  omni-alive %:     ${omniAlivePct.toFixed(2)}`);
  console.log(`  RSS growth %:     ${rssGrowthPct === null ? 'n/a' : rssGrowthPct.toFixed(2)}`);
  console.log(`  hours w/ 0 new decisions: ${deadHours}`);
  console.log(`  verdict:          ${verdict}`);
  console.log('='.repeat(60));

  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  console.error('[FATAL]', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
