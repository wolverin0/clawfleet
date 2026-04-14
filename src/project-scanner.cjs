#!/usr/bin/env node
/**
 * Project Scanner — discovers Claude Code + Codex projects on disk.
 *
 * Claude Code: sessions live under ~/.claude/projects/<url-escaped-cwd>/<uuid>.jsonl
 * Codex CLI:   sessions live under ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * For each project directory this resolves the real cwd (by reading the `cwd`
 * field from the newest JSONL) and returns a light summary for UI use or for
 * OmniClaude to render a `/projects` reply in Telegram.
 *
 * Exports:
 *   scanProjects({ includeCodex=true, limit=null } = {}) -> Array<Project>
 *
 * CLI:
 *   node src/project-scanner.cjs [--json] [--no-codex] [--limit N]
 *     --json     : emit machine-readable JSON (default when piped)
 *     --no-codex : skip Codex session scanning
 *     --limit N  : cap the result to N most-recent projects
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR  = path.join(os.homedir(), '.codex', 'sessions');

// Cache decoded project paths — reading JSONL is costly, the encoded→real map is stable per session.
const realPathCache = new Map();

/** Read the last N bytes of a file efficiently (without loading the whole thing). */
function readLastBytes(filePath, bytes = 20000) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const toRead = Math.min(bytes, size);
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, size - toRead);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/** Extract the `cwd` field from the most recent JSONL in a project directory. */
function resolveClaudeProjectCwd(projectDir, encodedName) {
  if (realPathCache.has(encodedName)) return realPathCache.get(encodedName);
  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(projectDir, f);
        return { name: f, mtime: fs.statSync(full).mtimeMs, full };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);

    for (const { full } of files) {
      const tail = readLastBytes(full, 30000);
      for (const line of tail.split('\n')) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (typeof data.cwd === 'string' && data.cwd.length > 0) {
            realPathCache.set(encodedName, data.cwd);
            return data.cwd;
          }
        } catch { /* malformed line — skip */ }
      }
    }
  } catch { /* dir unreadable */ }
  // Fallback: un-escape hyphens to path separators heuristically
  const heur = encodedName.replace(/---/g, ':/').replace(/-/g, path.sep);
  realPathCache.set(encodedName, heur);
  return heur;
}

function friendlyName(realPath) {
  if (!realPath) return null;
  const normalized = String(realPath).replace(/\\+$/g, '').replace(/\/+$/g, '');
  return path.basename(normalized) || normalized;
}

function scanClaudeProjects() {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
  const out = [];
  let entries;
  try { entries = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }); }
  catch { return []; }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, e.name);
    let jsonlFiles = [];
    try {
      jsonlFiles = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const full = path.join(projectDir, f);
          const st = fs.statSync(full);
          return { uuid: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, size: st.size };
        });
    } catch { continue; }

    if (jsonlFiles.length === 0) continue;
    jsonlFiles.sort((a, b) => b.mtime - a.mtime);

    const realPath = resolveClaudeProjectCwd(projectDir, e.name);
    out.push({
      agent: 'claude',
      encoded: e.name,
      realPath,
      name: friendlyName(realPath),
      sessionCount: jsonlFiles.length,
      latestSessionUuid: jsonlFiles[0].uuid,
      latestActivityMs: jsonlFiles[0].mtime,
    });
  }
  return out;
}

function scanCodexSessions() {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return [];
  const byCwd = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue;
      const tail = readLastBytes(full, 8000);
      let cwd = null;
      for (const line of tail.split('\n')) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (typeof data.cwd === 'string') { cwd = data.cwd; break; }
        } catch { /* skip */ }
      }
      if (!cwd) continue;
      const st = fs.statSync(full);
      const uuidMatch = e.name.match(/rollout-[\d-]+-(.+)\.jsonl$/);
      const uuid = uuidMatch ? uuidMatch[1] : e.name;
      const entry = byCwd.get(cwd) || { agent: 'codex', realPath: cwd, name: friendlyName(cwd), sessionCount: 0, latestActivityMs: 0, latestSessionUuid: null };
      entry.sessionCount++;
      if (st.mtimeMs > entry.latestActivityMs) {
        entry.latestActivityMs = st.mtimeMs;
        entry.latestSessionUuid = uuid;
      }
      byCwd.set(cwd, entry);
    }
  };
  walk(CODEX_SESSIONS_DIR);
  return Array.from(byCwd.values());
}

function scanProjects({ includeCodex = true, limit = null } = {}) {
  const all = [...scanClaudeProjects()];
  if (includeCodex) all.push(...scanCodexSessions());
  all.sort((a, b) => b.latestActivityMs - a.latestActivityMs);
  return limit && limit > 0 ? all.slice(0, limit) : all;
}

function formatHuman(projects) {
  if (projects.length === 0) return '(no Claude or Codex projects found on disk)';
  const now = Date.now();
  const fmtAge = (ms) => {
    const d = (now - ms) / 1000;
    if (d < 60) return `${Math.round(d)}s ago`;
    if (d < 3600) return `${Math.round(d / 60)}m ago`;
    if (d < 86400) return `${Math.round(d / 3600)}h ago`;
    return `${Math.round(d / 86400)}d ago`;
  };
  const lines = [];
  for (const p of projects) {
    const badge = p.agent === 'codex' ? '[codex]' : '[claude]';
    lines.push(`${badge} ${p.name}  ·  ${p.sessionCount} session${p.sessionCount === 1 ? '' : 's'}  ·  ${fmtAge(p.latestActivityMs)}`);
    lines.push(`         ${p.realPath}`);
  }
  return lines.join('\n');
}

module.exports = { scanProjects, scanClaudeProjects, scanCodexSessions, formatHuman };

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json') || !process.stdout.isTTY;
  const noCodex = args.includes('--no-codex');
  const limIdx = args.indexOf('--limit');
  const limit = limIdx >= 0 ? parseInt(args[limIdx + 1], 10) : null;
  const projects = scanProjects({ includeCodex: !noCodex, limit });
  if (json) process.stdout.write(JSON.stringify(projects, null, 2) + '\n');
  else process.stdout.write(formatHuman(projects) + '\n');
}
