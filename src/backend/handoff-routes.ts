/**
 * v2.7-parity handoff routes.
 *
 *   POST /api/a2a/handoff                  — push an A2A handoff request to a peer pane
 *   GET  /api/handoffs?session=<id>        — list .md files in <pane cwd>/handoffs/
 *
 * Both ports of v2.7 `src/dashboard-server.cjs`. The v2.3.1 design — the
 * dashboard does NOT inject into the target directly; it sends an
 * instructive prompt to the SOURCE pane so Claude itself authors the
 * handoff file and dispatches the A2A envelope via its own MCP tools —
 * carries over unchanged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PtyManager } from './pty-manager.js';

function slugify(s: string): string {
  return (
    String(s || 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unknown'
  );
}

function isoForFilename(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

function shortCorr(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0').slice(0, 6);
}

function projectNameOf(cwd: string, tabTitle: string | undefined): string {
  if (tabTitle && tabTitle.length > 0 && tabTitle !== 'cmd' && tabTitle !== 'bash') {
    return tabTitle;
  }
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

export interface A2aHandoffBody {
  source_session_id?: string;
  target_session_id?: string;
  instruction?: string;
  context?: string;
}

export interface A2aHandoffResult {
  ok: boolean;
  corr: string;
  source_session_id: string;
  target_session_id: string;
  suggested_file: string;
  note: string;
}

/**
 * Build + send the A2A handoff prompt to the SOURCE pane. Returns the
 * metadata the dashboard displays. Throws on validation error with a
 * descriptive message the caller turns into a 400/404 response.
 */
export function runA2aHandoff(
  manager: PtyManager,
  body: A2aHandoffBody,
): A2aHandoffResult {
  const sourceId = String(body.source_session_id ?? '');
  const targetId = String(body.target_session_id ?? '');
  const instruction = String(body.instruction ?? '').trim();
  const context = String(body.context ?? '').trim();

  if (!sourceId || !targetId) {
    throw new Error('source_session_id and target_session_id are required');
  }
  if (!instruction) {
    throw new Error('instruction is required');
  }

  const all = manager.list();
  const src = all.find((r) => r.sessionId === sourceId);
  const tgt = all.find((r) => r.sessionId === targetId);
  if (!src) throw new Error(`source session ${sourceId} not found`);
  if (!tgt) throw new Error(`target session ${targetId} not found`);

  const srcProject = projectNameOf(src.cwd, src.tabTitle);
  const tgtProject = projectNameOf(tgt.cwd, tgt.tabTitle);

  const corrShort = shortCorr();
  const corr = `handoff-${corrShort}`;
  const tsFile = isoForFilename();
  const suggestedFilename = `handoff-to-${slugify(tgtProject)}-${tsFile}-${corrShort}.md`;
  const suggestedPath = `handoffs/${suggestedFilename}`;

  const prompt =
    [
      `[Dashboard A2A Handoff Request]`,
      ``,
      `You are session ${sourceId.slice(0, 8)} (${srcProject}). A handoff has been requested FROM you TO session ${targetId.slice(0, 8)} (${tgtProject}, cwd: ${tgt.cwd}).`,
      ``,
      `Instruction for target: ${instruction}`,
      ...(context ? [``, `Additional context:`, context] : []),
      ``,
      `## Do these steps in order`,
      ``,
      `1. **Author a handoff file** at \`${suggestedPath}\` (relative to YOUR current cwd). Include:`,
      `   - What you have been doing recently`,
      `   - Current state / work-in-progress`,
      `   - What the target needs to know to pick up or contribute`,
      `   - Any files / commits / context relevant to the instruction above`,
      `   - Use a fresh unique filename — NEVER overwrite an existing handoff file.`,
      ``,
      `2. **Contact the target via wezbridge MCP** using this exact envelope (send_prompt followed by send_key 'enter'):`,
      `   \`\`\``,
      `   [A2A from session ${sourceId.slice(0, 8)} to session ${targetId.slice(0, 8)} | corr=${corr} | type=request]`,
      `   ${instruction}`,
      `   Full handoff context is in: ${srcProject}/${suggestedPath}`,
      `   \`\`\``,
      `   Call: \`mcp__wezbridge__send_prompt(sessionId="${targetId}", text=<envelope above>)\` then \`mcp__wezbridge__send_key(sessionId="${targetId}", key='enter')\`.`,
      ``,
      `3. **Briefly acknowledge here** that the file was written + the target was contacted, with the filename and corr id.`,
      ``,
      `Do not do the target's work yourself. Your job is only to author the handoff file and delegate via MCP.`,
    ].join('\n');

  // A2A hard rule: send_prompt then send_key('enter') — bundling `\r` into
  // the prompt write lets Claude's TUI absorb it as a newline in the draft.
  // `writeAndSubmit` flushes then sends Enter as a separate keystroke.
  void manager.writeAndSubmit(sourceId, prompt);

  return {
    ok: true,
    corr,
    source_session_id: sourceId,
    target_session_id: targetId,
    suggested_file: suggestedPath,
    note: 'Instruction prompt sent to source pane. Source pane will author handoff file + contact target via wezbridge MCP.',
  };
}

export interface HandoffEntry {
  filename: string;
  filepath: string;
  mtime: string | null;
  size: number;
  head: string;
}

const HANDOFF_SENT_RE = /\*\*Sent:\*\*\s*(.+)/i;
const HANDOFF_CORR_RE = /corr[:=]?\s*([a-z0-9_-]+)/i;

interface HandoffMeta {
  sent: string | null;
  corr: string | null;
}

function parseHandoffMeta(text: string): HandoffMeta {
  const head = text.split(/\r?\n/).slice(0, 25).join('\n');
  const sent = head.match(HANDOFF_SENT_RE);
  const corr = head.match(HANDOFF_CORR_RE);
  return {
    sent: sent ? sent[1]!.trim() : null,
    corr: corr ? corr[1]!.trim() : null,
  };
}

export interface HandoffListResult {
  handoffs: Array<HandoffEntry & HandoffMeta>;
  note?: string;
}

/**
 * Read handoff files from `<session cwd>/handoffs/*.md`. Returns sorted
 * newest-first by mtime. Missing directory is a non-error (empty list).
 */
export function listHandoffs(manager: PtyManager, sessionId: string): HandoffListResult {
  const rec = manager.list().find((r) => r.sessionId === sessionId);
  if (!rec) {
    return { handoffs: [], note: `session ${sessionId} not found` };
  }
  const handoffsDir = path.join(rec.cwd.replace(/\//g, path.sep), 'handoffs');
  if (!fs.existsSync(handoffsDir) || !fs.statSync(handoffsDir).isDirectory()) {
    return { handoffs: [], note: `no handoffs/ dir at ${handoffsDir}` };
  }
  const entries = fs
    .readdirSync(handoffsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'));

  const out: Array<HandoffEntry & HandoffMeta> = [];
  for (const e of entries) {
    const filepath = path.join(handoffsDir, e.name);
    let head = '';
    let size = 0;
    try {
      const stat = fs.statSync(filepath);
      size = stat.size;
      const fd = fs.openSync(filepath, 'r');
      try {
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        head = buf.slice(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const meta = parseHandoffMeta(head);
    let mtime: string | null = null;
    try {
      mtime = fs.statSync(filepath).mtime.toISOString();
    } catch {
      /* ignore */
    }
    out.push({
      filename: e.name,
      filepath,
      mtime,
      size,
      head: head.slice(0, 600),
      sent: meta.sent,
      corr: meta.corr,
    });
  }
  out.sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')));
  return { handoffs: out };
}
