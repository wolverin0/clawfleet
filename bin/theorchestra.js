#!/usr/bin/env node
/**
 * theorchestra CLI — Phase 9
 *
 * Subcommands:
 *   theorchestra start [--port 4300]    — boot backend + dashboard + MCP host
 *   theorchestra stop                    — SIGTERM a running instance on this port
 *   theorchestra rotate-token            — rotate vault/_auth/token.json
 *   theorchestra version                 — print version
 *
 * Zero external deps (plain node + fs). Delegates to scripts/theorchestra-start.ts
 * via tsx when run from a checkout; when installed via `npm install -g`
 * the published package includes a pre-compiled dist/start.js (future).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function repoRoot() {
  // When run from a checkout: bin/theorchestra.js → repoRoot is the parent.
  return path.resolve(__dirname, '..');
}

function loadPkgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

function tokenPath() {
  return (
    process.env.THEORCHESTRA_TOKEN_FILE ||
    path.resolve(repoRoot(), 'vault', '_auth', 'token.json')
  );
}

function cmdStart(args) {
  // Parse --port if present; pass through all other env.
  const portIdx = args.indexOf('--port');
  const env = { ...process.env };
  if (portIdx !== -1 && args[portIdx + 1]) {
    env.THEORCHESTRA_PORT = args[portIdx + 1];
  }
  const tsxCli = path.join(repoRoot(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const startScript = path.join(repoRoot(), 'scripts', 'theorchestra-start.ts');
  const child = spawn(process.execPath, [tsxCli, startScript], {
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function cmdStop() {
  // Best-effort stop: SIGTERM everything listening on the configured port.
  const port = Number(process.env.THEORCHESTRA_PORT) || 4300;
  let healthy = false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    healthy = r.ok;
  } catch {
    healthy = false;
  }
  if (!healthy) {
    console.log(`[theorchestra] no backend answering on :${port}`);
    return;
  }
  // There's no /api/shutdown yet — rely on the OS to SIGTERM node processes
  // that own the port. Cross-platform this is: Windows netstat+taskkill,
  // POSIX lsof+kill. Keep it simple — print instructions rather than do the
  // platform-specific dance.
  console.log(
    `[theorchestra] to stop the running backend on :${port}, SIGTERM the node process.\n` +
      `  Windows: for /f "tokens=5" %a in ('netstat -ano ^| findstr ":${port}"') do taskkill /PID %a /F\n` +
      `  POSIX:   kill $(lsof -ti:${port})`,
  );
}

function cmdRotateToken() {
  const pathForToken = tokenPath();
  try {
    const text = fs.readFileSync(pathForToken, 'utf-8');
    JSON.parse(text); // validate
  } catch (err) {
    console.error(`[theorchestra] no existing token at ${pathForToken} — start the backend once to generate one`);
    process.exit(1);
  }
  // We re-use AuthStore's rotation logic by shelling out to a tiny tsx one-liner.
  const tsxCli = path.join(repoRoot(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const tmpScript = path.join(repoRoot(), 'scripts', '.rotate-token-inline.cjs');
  // Inline script — we materialise a one-shot file so tsx can run it.
  const inline =
    "const { AuthStore } = require('../src/backend/auth.js'); " +
    "const store = new AuthStore(process.env.THEORCHESTRA_TOKEN_FILE || require('path').resolve('vault', '_auth', 'token.json')); " +
    "const token = store.rotate(); " +
    "process.stdout.write(token + '\\n');";
  // Keep it portable — invoke via node + our compiled sources wouldn't exist
  // from a global install yet, so read the current token and rewrite it here.
  const crypto = require('node:crypto');
  const raw = fs.readFileSync(pathForToken, 'utf-8');
  const existing = JSON.parse(raw);
  const newToken = crypto.randomBytes(32).toString('base64url');
  const payload = {
    token: newToken,
    createdAt: existing.createdAt || new Date().toISOString(),
    rotatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(pathForToken, JSON.stringify(payload, null, 2), 'utf-8');
  try {
    fs.chmodSync(pathForToken, 0o600);
  } catch {
    /* Windows or permission — ignore */
  }
  console.log(`[theorchestra] rotated token → ${pathForToken}`);
  console.log(`  new token: ${newToken}`);
  console.log('  paste it into the dashboard /login form; the previous token is now invalid.');
}

function cmdVersion() {
  console.log(`theorchestra ${loadPkgVersion()}`);
}

function main(argv) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case 'start':
      return cmdStart(rest);
    case 'stop':
      return cmdStop();
    case 'rotate-token':
      return cmdRotateToken();
    case '--version':
    case '-v':
    case 'version':
      return cmdVersion();
    case 'help':
    case '--help':
    case '-h':
      console.log('usage: theorchestra [start [--port <n>] | stop | rotate-token | version]');
      return;
    default:
      console.error(`unknown subcommand: ${sub}`);
      console.error('usage: theorchestra [start | stop | rotate-token | version]');
      process.exit(2);
  }
}

main(process.argv.slice(2));
