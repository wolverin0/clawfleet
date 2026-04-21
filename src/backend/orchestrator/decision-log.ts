/**
 * Append-only audit log for orchestrator decisions. Writes one JSON line per
 * decision to `vault/_orchestrator/decisions-YYYY-MM-DD.md`, inside a single
 * fenced `json` block per day so the file is still readable as markdown.
 *
 * Carried over from v2.7's `vault/_orchestrator/decisions-<date>.md` log.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DecisionRecord } from './types.js';

export class DecisionLog {
  /**
   * In-memory ring of recent decisions for quick consumers (advisor context,
   * UI reasoning panel). Persistence still lives on disk — this is just a
   * cache so we don't re-parse the markdown file on every advise() call.
   */
  private readonly recent: DecisionRecord[] = [];
  private readonly recentCap = 200;

  constructor(private readonly dir: string) {}

  private pathForDate(d: Date = new Date()): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return path.join(this.dir, `decisions-${y}-${m}-${day}.md`);
  }

  append(rec: DecisionRecord): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.pathForDate(new Date(rec.ts));
    const line = JSON.stringify(rec);
    if (!fs.existsSync(file)) {
      const header =
        `# Orchestrator decisions — ${path.basename(file, '.md').replace('decisions-', '')}\n\n` +
        `Append-only log. Each entry is a single JSON line between the fences below.\n\n` +
        '```json\n';
      fs.writeFileSync(file, header, 'utf-8');
    }
    // Append the line (no closing fence — the file stays "open" by design).
    fs.appendFileSync(file, line + '\n', 'utf-8');
    // Mirror into the in-memory recent ring.
    this.recent.push(rec);
    if (this.recent.length > this.recentCap) {
      this.recent.splice(0, this.recent.length - this.recentCap);
    }
  }

  /** Recent in-memory decisions, oldest → newest. Cheap — no disk read. */
  tail(n: number): DecisionRecord[] {
    return this.recent.slice(Math.max(0, this.recent.length - n));
  }

  readAll(file: string): DecisionRecord[] {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf-8');
    const start = text.indexOf('```json');
    if (start === -1) return [];
    const body = text.slice(start + '```json'.length);
    const out: DecisionRecord[] = [];
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('```')) continue;
      try {
        out.push(JSON.parse(trimmed) as DecisionRecord);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }

  /** For tests — the path the next append would write to. */
  currentFile(now: Date = new Date()): string {
    return this.pathForDate(now);
  }
}
