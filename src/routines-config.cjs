/**
 * routines-config.cjs — Claude Routines config loader.
 *
 * Reads `vault/_routines-config.md` (gitignored; user-owned) and parses
 * per-routine YAML blocks into an in-memory list of routine descriptors.
 *
 * IMPORTANT: this file never stores bearer tokens. Each routine names an
 * environment variable (`token_env`) that the server reads at fire-time.
 *
 * Supported format — one fenced ```yaml block per routine:
 *
 *     ```yaml
 *     id: trig_abc123
 *     token_env: ROUTINE_TRIG_ABC123_TOKEN
 *     triggers:
 *       - build_failed
 *       - nightly
 *     notes: Build recovery routine.
 *     ```
 *
 * Exports: { loadRoutines, getRoutine, reload, defaultTokenEnv }.
 */

const fs = require('fs');
const path = require('path');

const VAULT_PATH = process.env.VAULT_PATH
  || path.join(__dirname, '..', 'vault');
const CONFIG_PATH = path.join(VAULT_PATH, '_routines-config.md');
const CACHE_TTL_MS = 30 * 1000;

let cache = { ts: 0, routines: [] };

function defaultTokenEnv(id) {
  const safe = String(id || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `ROUTINE_${safe || 'UNKNOWN'}_TOKEN`;
}

// Tiny YAML parser — only handles the subset we need:
//   key: value
//   key:
//     - item
//     - item
// Values are strings; no nested maps, no flow syntax.
function parseYamlBlock(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  let currentKey = null;
  let currentList = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // List item for the current key
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentKey && currentList) {
      currentList.push(listMatch[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      currentKey = key;
      if (val === '' || val === '|' || val === '>') {
        // block that may contain a list on following indented lines
        out[key] = [];
        currentList = out[key];
      } else {
        out[key] = val.replace(/^["']|["']$/g, '');
        currentList = null;
      }
    }
  }

  return out;
}

function extractYamlBlocks(md) {
  const blocks = [];
  const re = /```yaml\s*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function normalize(entry) {
  if (!entry || !entry.id) return null;
  const id = String(entry.id).trim();
  if (!id) return null;
  const triggers = Array.isArray(entry.triggers) ? entry.triggers.map(String) : [];
  const token_env = entry.token_env ? String(entry.token_env).trim() : defaultTokenEnv(id);
  const notes = entry.notes ? String(entry.notes) : '';
  return { id, token_env, triggers, notes };
}

function loadRoutines() {
  const now = Date.now();
  if (now - cache.ts < CACHE_TTL_MS) return cache.routines;

  if (!fs.existsSync(CONFIG_PATH)) {
    cache = { ts: now, routines: [] };
    return cache.routines;
  }

  let routines = [];
  try {
    const md = fs.readFileSync(CONFIG_PATH, 'utf8');
    const blocks = extractYamlBlocks(md);
    routines = blocks.map(parseYamlBlock).map(normalize).filter(Boolean);
  } catch (err) {
    // Never throw — routines are optional. Surface via empty list.
    routines = [];
  }

  cache = { ts: now, routines };
  return cache.routines;
}

function getRoutine(id) {
  if (!id) return null;
  return loadRoutines().find(r => r.id === id) || null;
}

function reload() {
  cache = { ts: 0, routines: [] };
  return loadRoutines();
}

module.exports = { loadRoutines, getRoutine, reload, defaultTokenEnv };
