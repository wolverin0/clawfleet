#!/usr/bin/env node
/**
 * commit-guard.js — Hard enforcement for OmniClaude commit safety.
 *
 * Two entry points, identical logic:
 *   1. Claude Code PreToolUse hook (via .claude/settings.json per project)
 *   2. Git native pre-commit hook (via .git/hooks/pre-commit per repo)
 *
 * Exit 0 = allow, Exit 1 = block (with reason on stderr).
 *
 * Rules (on main branch only):
 *   BLOCK if >= 4 staged files
 *   BLOCK if any staged file is infra (docker*, .env*, *.yml, Dockerfile, nginx*, deploy*, migrate*, package.json)
 *   BLOCK if any staged file is NEW (untracked → staged)
 *   BLOCK if command contains --no-verify, -n (flag), reset --hard, checkout ., push --force, rm -rf, drop
 *   BLOCK if staged files span multiple top-level directories (cross-module)
 *   ALLOW everything on non-main branches
 *   ALLOW read-only git commands (status, log, diff, branch, stash list)
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { execSync } = require('child_process');

const INFRA_PATTERNS = [
  /^\.env/i,
  /^docker/i,
  /dockerfile/i,
  /^\.github\//i,
  /\.ya?ml$/i,
  /^nginx/i,
  /^deploy/i,
  /^migrate/i,
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^composer\.json$/i,
  /^Gemfile$/i,
  /^Pipfile$/i,
  /^pyproject\.toml$/i,
  /^requirements.*\.txt$/i,
];

const DESTRUCTIVE_PATTERNS = [
  /--no-verify/,
  /\s-n\s/,            // short flag for --no-verify (with spaces to avoid false positives like "-next")
  /reset\s+--hard/,
  /checkout\s+\./,
  /push\s+--force/,
  /push\s+-f\b/,
  /rm\s+-rf/,
  /\bdrop\s+/i,
  /clean\s+-fd/,
  /branch\s+-D/,
];

const READ_ONLY_COMMANDS = [
  /^git\s+(status|log|diff|branch|stash\s+list|show|remote|fetch|tag|describe|rev-parse|ls-files|blame|shortlog)/,
];

function block(reason) {
  process.stderr.write(`commit-guard: BLOCKED — ${reason}\n`);
  process.stderr.write(`commit-guard: Create a branch first: git checkout -b omni/fix-<name>\n`);
  process.exit(1);
}

function allow() {
  process.exit(0);
}

// --- Detect entry point ---
// When called from PreToolUse, the full bash command is in TOOL_INPUT or argv
// When called from git pre-commit hook, there's no command — just check staged files
const toolInput = process.env.TOOL_INPUT || process.argv.slice(2).join(' ');
const isGitHook = !toolInput; // no command = called from git hook

// --- For PreToolUse: check if command is read-only ---
if (!isGitHook && toolInput) {
  // Check if it's a read-only git command — always allow
  for (const pattern of READ_ONLY_COMMANDS) {
    if (pattern.test(toolInput)) allow();
  }

  // Check for destructive patterns in the command itself
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(toolInput)) {
      block(`Destructive command detected: ${toolInput.substring(0, 100)}`);
    }
  }
}

// --- Check branch ---
let branch;
try {
  branch = execSync('git branch --show-current', { encoding: 'utf8', timeout: 5000 }).trim();
} catch {
  // Not in a git repo — allow (not our problem)
  allow();
}

// Allow everything on non-main branches
if (branch !== 'main' && branch !== 'master') {
  allow();
}

// --- On main: check staged files ---
let stagedFiles;
try {
  const raw = execSync('git diff --cached --name-only --diff-filter=ACMR', {
    encoding: 'utf8',
    timeout: 5000,
  });
  stagedFiles = raw.trim().split('\n').filter(Boolean);
} catch {
  // Can't read staged files — allow (git hook might run before anything is staged)
  allow();
}

// No staged files = nothing to block
if (stagedFiles.length === 0) {
  allow();
}

// Rule: >= 4 files on main
if (stagedFiles.length >= 4) {
  block(`${stagedFiles.length} files staged on main (max 3). Use a PR branch.`);
}

// Rule: infra files on main
for (const file of stagedFiles) {
  const basename = file.split('/').pop();
  for (const pattern of INFRA_PATTERNS) {
    if (pattern.test(basename) || pattern.test(file)) {
      block(`Infrastructure file "${file}" on main. Use a PR branch.`);
    }
  }
}

// Rule: new files on main
try {
  const newFiles = execSync('git diff --cached --name-only --diff-filter=A', {
    encoding: 'utf8',
    timeout: 5000,
  }).trim().split('\n').filter(Boolean);

  if (newFiles.length > 0) {
    block(`New file(s) on main: ${newFiles.slice(0, 3).join(', ')}. Use a PR branch.`);
  }
} catch {
  // Can't detect new files — proceed with other checks
}

// Rule: cross-directory (files in different top-level dirs)
const topDirs = new Set(stagedFiles.map(f => f.split('/')[0]));
if (topDirs.size > 1) {
  block(`Cross-directory commit on main (${[...topDirs].join(', ')}). Use a PR branch.`);
}

// All checks passed — small fix on main, allowed
allow();
