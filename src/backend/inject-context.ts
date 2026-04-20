/**
 * Cross-pane context injection. The `Ctx` button on a pane-card lets the
 * user pick N other live panes, then send their most recent rendered
 * output to the target pane as a single prompt. Mirrors v2.7
 * `injectContext()` — useful for "bring Claude-A up to speed on what
 * Claude-B has been doing" without a full handoff file.
 */

import type { PtyManager } from './pty-manager.js';
import type { SessionId } from '../shared/types.js';

export interface InjectContextBody {
  source_session_ids?: unknown;
  lines?: unknown;
  header?: unknown;
}

export interface InjectContextResult {
  ok: boolean;
  bytes_written: number;
  sources: Array<{ session_id: SessionId; tab_title: string; lines_included: number }>;
}

function projectNameOf(cwd: string, tabTitle: string | undefined): string {
  if (tabTitle && tabTitle.length > 0 && tabTitle !== 'cmd' && tabTitle !== 'bash') {
    return tabTitle;
  }
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

/**
 * Build the context block + write to the target pane as a prompt + Enter.
 * Sources are each rendered as:
 *
 *     [Context from <name> (<sid8>)]
 *     <last N rendered lines>
 *
 * Returns bytes written + per-source counts. Throws on validation.
 */
export function injectContext(
  manager: PtyManager,
  targetSessionId: SessionId,
  body: InjectContextBody,
): InjectContextResult {
  const rawIds = Array.isArray(body.source_session_ids) ? body.source_session_ids : [];
  const sourceIds = rawIds.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (sourceIds.length === 0) {
    throw new Error('source_session_ids must be a non-empty string[]');
  }
  const linesRaw = typeof body.lines === 'number' ? body.lines : 40;
  const lines = Math.max(5, Math.min(200, Math.floor(linesRaw)));
  const header =
    typeof body.header === 'string' && body.header.length > 0
      ? body.header
      : '[Context from peer panes]';

  const target = manager.list().find((r) => r.sessionId === targetSessionId);
  if (!target) throw new Error(`target session ${targetSessionId} not found`);

  const sources: InjectContextResult['sources'] = [];
  const blocks: string[] = [header, ''];
  for (const sid of sourceIds) {
    const rec = manager.list().find((r) => r.sessionId === sid);
    if (!rec) {
      blocks.push(`[${sid.slice(0, 8)}] (not found — skipped)`);
      continue;
    }
    const name = projectNameOf(rec.cwd, rec.tabTitle);
    const tail = manager.renderedTail(sid, lines);
    const nonEmpty = tail.filter((l) => l.trim().length > 0);
    blocks.push(`--- ${name} (${sid.slice(0, 8)}) — last ${nonEmpty.length} lines ---`);
    blocks.push(...nonEmpty);
    blocks.push('');
    sources.push({ session_id: sid, tab_title: name, lines_included: nonEmpty.length });
  }
  blocks.push(
    `[End of context. Please acknowledge what you see above before continuing.]`,
  );

  const payload = blocks.join('\n');
  manager.write(targetSessionId, payload);
  manager.write(targetSessionId, '\r');
  return { ok: true, bytes_written: payload.length + 1, sources };
}
