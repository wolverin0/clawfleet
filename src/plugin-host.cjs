#!/usr/bin/env node
/**
 * theorchestra plugin host — runtime event-bus for user-supplied plugins.
 *
 * Design notes:
 *  - This is a SIBLING process to omni-watcher.cjs, not a modification of it.
 *    It spawns the watcher as a child, parses each watcher event (JSON line),
 *    forwards it to its own stdout unchanged (so whoever is `Monitor`ing this
 *    host sees the same stream it would see from the watcher directly), AND
 *    dispatches the event to plugin handlers subscribed to that event type.
 *  - Plugins are zero-privilege: they get a minimal `ctx` with event bus,
 *    WezTerm read helpers, and a logger. They CANNOT post to Telegram
 *    (OmniClaude owns that), CANNOT mutate pane state directly (emit events
 *    for OmniClaude to react to), and CANNOT access secrets.
 *  - Agent-centric framing: plugins extend the *observation* side, not the
 *    *coordination* side. The coordinator is a Claude Code session.
 *
 * Plugin contract:
 *   module.exports = {
 *     name: 'my-plugin',
 *     register(ctx) { … wire handlers … }
 *   };
 *
 * Usage:
 *   node src/plugin-host.cjs                   — spawns watcher, loads all plugins
 *   THEORCHESTRA_PLUGINS=dir1,dir2 node host.cjs  — override plugin search dirs
 *
 * To use via OmniClaude's Monitor tool:
 *   Monitor({ command: "node path/to/src/plugin-host.cjs", persistent: true })
 *
 *   ← replaces the direct `node omni-watcher.cjs` Monitor call.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const wez = require('./wezterm.cjs');

const DEFAULT_PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const PLUGIN_DIRS = (process.env.THEORCHESTRA_PLUGINS || DEFAULT_PLUGINS_DIR)
  .split(path.delimiter)
  .map(s => s.trim())
  .filter(Boolean);

const WATCHER_PATH = path.join(__dirname, 'omni-watcher.cjs');

function emit(event) {
  try { process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n'); }
  catch { /* stdout closed */ }
}

function log(msg) {
  process.stderr.write(`[plugin-host] ${new Date().toISOString()} ${msg}\n`);
}

class PluginRuntime {
  constructor() {
    this.plugins = new Map();    // name -> { module, ctx, file }
    this.handlers = new Map();   // event -> [{ plugin, fn }]
  }

  loadDir(dir) {
    if (!fs.existsSync(dir)) {
      log(`Plugin dir not found: ${dir} (skipping)`);
      return;
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (err) { log(`Cannot read plugin dir ${dir}: ${err.message}`); return; }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      let mainFile = null;
      if (entry.isDirectory()) {
        for (const candidate of ['index.cjs', 'index.js', 'main.cjs']) {
          const p = path.join(full, candidate);
          if (fs.existsSync(p)) { mainFile = p; break; }
        }
        if (!mainFile) continue;
      } else if (entry.isFile() && entry.name.endsWith('.cjs')) {
        mainFile = full;
      } else {
        continue;
      }
      this.loadPlugin(mainFile);
    }
  }

  loadPlugin(file) {
    try {
      // Bust require cache so `plugin-host` restart reliably reloads
      delete require.cache[require.resolve(file)];
      const mod = require(file);
      if (!mod || typeof mod.register !== 'function' || typeof mod.name !== 'string') {
        log(`Skipping ${file}: missing { name, register }`);
        return;
      }
      if (this.plugins.has(mod.name)) {
        log(`Duplicate plugin name "${mod.name}" from ${file} — skipping`);
        return;
      }
      const ctx = this._createCtx(mod.name);
      mod.register(ctx);
      this.plugins.set(mod.name, { module: mod, ctx, file });
      log(`Loaded plugin "${mod.name}" from ${path.relative(process.cwd(), file)}`);
      emit({ source: 'plugin-host', event: 'plugin_loaded', plugin: mod.name });
    } catch (err) {
      log(`Error loading ${file}: ${err.message}`);
      emit({ source: 'plugin-host', event: 'plugin_load_error', file, error: err.message });
    }
  }

  _createCtx(pluginName) {
    const self = this;
    return {
      pluginName,
      wezterm: wez,
      discoverPanes: () => wez.listPanes(),
      readOutput: (paneId, lines = 80) => {
        try { return wez.getFullText(paneId, lines); }
        catch { return ''; }
      },
      on: (event, handler) => {
        if (typeof event !== 'string' || typeof handler !== 'function') return;
        if (!self.handlers.has(event)) self.handlers.set(event, []);
        self.handlers.get(event).push({ plugin: pluginName, fn: handler });
      },
      emit: (event, payload = {}) => {
        emit({ source: `plugin:${pluginName}`, event, ...payload });
      },
      log: (msg) => log(`[${pluginName}] ${msg}`),
    };
  }

  dispatch(event) {
    const eventName = event && event.event ? event.event : null;
    if (!eventName) return;
    const subs = [
      ...(this.handlers.get(eventName) || []),
      ...(this.handlers.get('*') || []),
    ];
    for (const sub of subs) {
      try { sub.fn(event); }
      catch (err) { log(`Plugin "${sub.plugin}" handler for ${eventName} threw: ${err.message}`); }
    }
  }
}

const runtime = new PluginRuntime();
for (const dir of PLUGIN_DIRS) runtime.loadDir(dir);

emit({
  source: 'plugin-host',
  event: 'started',
  plugins: Array.from(runtime.plugins.keys()),
  plugin_dirs: PLUGIN_DIRS,
});

// ── Spawn watcher as child, fan out events ──
const watcher = spawn(process.execPath, [WATCHER_PATH], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buf = '';
watcher.stdout.on('data', chunk => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    // Forward original watcher event to our stdout — upstream Monitor sees
    // the same JSON stream it would have gotten by reading the watcher directly.
    try { process.stdout.write(line + '\n'); }
    catch { /* closed */ }
    // Parse and dispatch to plugins
    let event;
    try { event = JSON.parse(line); }
    catch { continue; }
    runtime.dispatch(event);
  }
});

watcher.stderr.on('data', chunk => {
  process.stderr.write(`[watcher] ${chunk}`);
});

watcher.on('exit', code => {
  emit({ source: 'plugin-host', event: 'watcher_exit', code });
  log(`watcher exited with code ${code}`);
  process.exit(code || 0);
});

process.on('SIGTERM', () => { watcher.kill(); process.exit(0); });
process.on('SIGINT', () => { watcher.kill(); process.exit(0); });
