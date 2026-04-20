#!/usr/bin/env node
/**
 * theorchestra-mcp — v3.0 MCP server wrapper.
 *
 * Registered in the user's global `~/.claude.json` under `mcpServers.wezbridge`
 * so every Claude Code session (including panes spawned by theorchestra
 * itself) gets `mcp__wezbridge__*` tools. Tsx-loads src/mcp/server.ts from
 * the checkout; all stdout is MCP protocol, all logs go to stderr.
 *
 * Replaces the v2.7 `src/mcp-server.cjs` which depended on WezTerm CLI and
 * fails on startup in a WezTerm-less v3.0 world.
 */

'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverEntry = path.join(repoRoot, 'src', 'mcp', 'server.ts');

const child = spawn(process.execPath, [tsxCli, serverEntry], {
  stdio: 'inherit',
  env: { ...process.env },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
