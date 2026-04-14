#!/usr/bin/env node
/**
 * Diff Reporter — compact git-diff summary for posting after a session completes.
 *
 * Triggered by OmniClaude (or anything else) after `session_completed` or on
 * demand via the CLI. Designed to answer "what did that pane actually change?"
 * in ≤400 chars of Telegram markup.
 *
 * Exports:
 *   getRepoStatus(cwd)          -> { root, branch, clean, staged, unstaged }
 *   getDiffSummary(cwd, opts)   -> { summary, files, html, plain } | null
 *   getRecentCommits(cwd, n)    -> [{ sha, subject, author, ts }, …]
 *
 * CLI:
 *   node src/diff-reporter.cjs [cwd]      — pretty-print a summary
 *   node src/diff-reporter.cjs [cwd] --json
 */

const { execFileSync } = require('child_process');
const path = require('path');

function git(cwd, args, timeout = 10000) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      timeout,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function getRepoStatus(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const branch = git(root, ['branch', '--show-current']) || '(detached)';
  const porcelain = git(root, ['status', '--porcelain']) ?? '';
  const lines = porcelain.split('\n').filter(l => l.trim());
  const staged = [];
  const unstaged = [];
  for (const l of lines) {
    const idx = l[0];
    const work = l[1];
    const file = l.slice(3);
    if (idx && idx !== ' ' && idx !== '?') staged.push({ status: idx, file });
    if (work && work !== ' ') unstaged.push({ status: work, file });
  }
  return { root, branch, clean: lines.length === 0, staged, unstaged };
}

function getDiffSummary(cwd, { includeStaged = true, maxFiles = 8 } = {}) {
  const st = getRepoStatus(cwd);
  if (!st) return null;

  // numstat for both unstaged and staged
  const rawU = git(st.root, ['diff', '--numstat']) || '';
  const rawS = includeStaged ? (git(st.root, ['diff', '--cached', '--numstat']) || '') : '';
  const parseNum = (raw, staged) => raw.split('\n').filter(Boolean).map(line => {
    const [ins, del, file] = line.split('\t');
    return {
      file: file || '',
      insertions: ins === '-' ? 0 : parseInt(ins, 10) || 0,
      deletions: del === '-' ? 0 : parseInt(del, 10) || 0,
      staged,
    };
  });
  const files = [...parseNum(rawU, false), ...parseNum(rawS, true)];
  // Tracked changes only — untracked files show in status.unstaged but not in diff.
  // If nothing to diff, return null; callers can inspect getRepoStatus separately.
  if (files.length === 0) return null;

  const totalIns = files.reduce((s, f) => s + f.insertions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);
  const top = files
    .slice()
    .sort((a, b) => (b.insertions + b.deletions) - (a.insertions + a.deletions))
    .slice(0, maxFiles);

  const summary = `${files.length} file${files.length === 1 ? '' : 's'} changed, +${totalIns} -${totalDel} on ${st.branch}`;

  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const htmlLines = [`<b>${escapeHtml(summary)}</b>`];
  for (const f of top) {
    const marker = f.staged ? '●' : '○';
    htmlLines.push(`<code>${marker} ${escapeHtml(f.file)}</code>  +${f.insertions} -${f.deletions}`);
  }
  if (files.length > top.length) htmlLines.push(`<i>…${files.length - top.length} more</i>`);
  const html = htmlLines.join('\n');

  const plainLines = [summary];
  for (const f of top) plainLines.push(`  ${f.staged ? '●' : '○'} ${f.file}  +${f.insertions} -${f.deletions}`);
  if (files.length > top.length) plainLines.push(`  …${files.length - top.length} more`);
  const plain = plainLines.join('\n');

  return { summary, files, top, html, plain, branch: st.branch, clean: false };
}

function getRecentCommits(cwd, n = 5) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return [];
  const raw = git(root, ['log', `-${n}`, '--pretty=format:%h|%an|%at|%s']);
  if (!raw) return [];
  return raw.split('\n').map(line => {
    const [sha, author, ts, ...subj] = line.split('|');
    return { sha, author, ts: parseInt(ts, 10) * 1000, subject: subj.join('|') };
  });
}

module.exports = { getRepoStatus, getDiffSummary, getRecentCommits };

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const cwdArg = args.find(a => !a.startsWith('--')) || process.cwd();
  const cwd = path.resolve(cwdArg);
  const summary = getDiffSummary(cwd);
  const status = getRepoStatus(cwd);
  const commits = getRecentCommits(cwd, 3);

  if (json) {
    process.stdout.write(JSON.stringify({ status, summary, commits }, null, 2) + '\n');
  } else if (!status) {
    process.stdout.write(`${cwd} is not a git repo.\n`);
  } else if (status.clean) {
    process.stdout.write(`${status.branch}: working tree clean.\nRecent: ${commits.map(c => c.sha + ' ' + c.subject).join(' · ')}\n`);
  } else {
    process.stdout.write(summary.plain + '\n');
  }
}
