# theorchestra plugin system

A zero-dependency, observe-and-emit plugin runtime. Plugins hook into watcher events, run arbitrary Node code, and publish their own events back to the theorchestra stream.

## Architecture

```
                     ┌─────────────────────────────┐
                     │   OmniClaude (or dashboard) │
                     │   Monitor tool subscriber   │
                     └──────────────▲──────────────┘
                                    │ stdout JSON stream
                                    │ (watcher events + plugin emits, interleaved)
                     ┌──────────────┴──────────────┐
                     │    src/plugin-host.cjs      │
                     │  ┌───────────────────────┐  │
                     │  │  plugins/ <name>/     │  │
                     │  │     index.cjs         │  │── handlers subscribed to events
                     │  │     index.cjs         │  │
                     │  └───────────────────────┘  │
                     └──────────────▲──────────────┘
                                    │ forwards every line + dispatches to plugins
                     ┌──────────────┴──────────────┐
                     │   src/omni-watcher.cjs      │
                     │   (spawned as child)        │
                     └─────────────────────────────┘
```

The host is a drop-in replacement for calling the watcher directly:

```
# before
Monitor({ command: "node src/omni-watcher.cjs", persistent: true })

# after (same event stream + plugins active)
Monitor({ command: "node src/plugin-host.cjs", persistent: true })
```

Upstream subscribers see exactly the same events they used to, plus any plugin emits.

## Plugin contract

```js
// plugins/<name>/index.cjs  — OR  plugins/<name>.cjs
module.exports = {
  name: 'unique-name',           // must be unique across all loaded plugins
  register(ctx) {
    // wire your handlers here
    ctx.on('session_completed', (ev) => { /* … */ });
    ctx.emit('my-event', { foo: 'bar' });
  },
};
```

The host loads every `.cjs` file directly under `plugins/` plus every `plugins/<dir>/index.cjs` (also `index.js` and `main.cjs` as fallbacks). Files/dirs starting with `.` or `_` are ignored.

## Context API

| Field | Type | Description |
|---|---|---|
| `ctx.pluginName` | `string` | The plugin's declared name (for logging / correlation). |
| `ctx.wezterm` | object | The `src/wezterm.cjs` module — full WezTerm CLI wrapper for read-only introspection. See its source for the method list. |
| `ctx.discoverPanes()` | `() => Pane[]` | Returns the raw WezTerm pane list (shortcut for `ctx.wezterm.listPanes()`). |
| `ctx.readOutput(paneId, lines?=80)` | `(number, number) => string` | Read the last `lines` lines of a pane's scrollback. Returns `''` on failure. |
| `ctx.on(event, handler)` | `(string, (ev) => void) => void` | Subscribe to a watcher or plugin event. Use `'*'` to subscribe to all events. |
| `ctx.emit(event, payload?={})` | `(string, object) => void` | Publish a custom event to stdout. `source` is auto-set to `plugin:<your name>`. |
| `ctx.log(msg)` | `(string) => void` | Write to the host's stderr with a plugin-tagged prefix. |

### What you do NOT get

- No `ctx.sendMsg` / `ctx.bot` — theorchestra is agent-centric; OmniClaude owns Telegram.
- No `ctx.sendPrompt` / `ctx.sendKey` / `ctx.kill` — plugins observe, they don't act on panes. Emit an event and let OmniClaude decide.
- No `ctx.fs` / network helpers — plugins can `require('fs')` or `require('https')` themselves; the context doesn't wrap stdlib.
- No implicit access to `process.env` — if you need an env var, read it explicitly in your plugin's module scope (not passed via ctx).

## Events you can subscribe to

Any event the watcher emits is routable. Common ones:

| Event | Fields |
|---|---|
| `session_started`, `session_completed`, `session_started_working` | `pane`, `project`, `severity`, `details` |
| `session_permission` | `pane`, `project`, `severity: "P1"`, `details` |
| `session_stuck`, `session_dead` | `pane`, `project`, `severity: "P2"`, `details` |
| `peer_orphaned` | `corr`, `dead_peer`, `survivor`, `pane`, `project` |
| `heartbeat` | `sessions` |
| `metrics_summary` | `sessions: [{ project, pane, ctx, session, weekly, model }]` |
| `relaunch_me` | (watcher signalling its own 55-min recycle) |

Plus any event any OTHER plugin emits — plugin-to-plugin event composition works out of the box.

## Example: auto-label panes for Telegram readability

```js
// plugins/auto-label/index.cjs
module.exports = {
  name: 'auto-label',
  register(ctx) {
    ctx.on('session_started', (ev) => {
      // On new session: read the first non-empty line and tag it as a hint
      const output = ctx.readOutput(ev.pane, 10);
      const firstLine = (output.split('\n').find(l => l.trim()) || '').slice(0, 60);
      ctx.emit('pane_label_hint', {
        pane: ev.pane,
        project: ev.project,
        hint: firstLine,
      });
    });
  },
};
```

OmniClaude can then react to `pane_label_hint` events and call `mcp__wezbridge__set_tab_title` with a friendly name.

## Running the host

```bash
# default — loads plugins/ relative to the repo
node src/plugin-host.cjs

# alternate plugin dir (or multiple, separated by : on Unix, ; on Windows)
THEORCHESTRA_PLUGINS=/path/to/my-plugins node src/plugin-host.cjs
```

Under PM2 (recommended for production):

```js
// edit ecosystem.config.cjs — replace the 'theorchestra-watcher' entry (if used)
{
  name: 'theorchestra-plugin-host',
  script: 'src/plugin-host.cjs',
  autorestart: true,
  max_memory_restart: '512M',
  restart_delay: 3000,
  max_restarts: 20,
},
```

## Safety considerations

- **Plugins run with the same OS privileges as the host.** They CAN read files, open sockets, spawn processes. Trust your `plugins/` directory like you'd trust any other code in your repo.
- **A plugin exception is caught per-dispatch**, not per-handler. If one plugin's `on('session_completed')` throws, the host logs the error and continues dispatching to other plugins.
- **Plugins are loaded once at host startup.** Restart the host to pick up plugin code changes. Hot-reload is intentionally not in v1.0 — lifecycle surprises aren't worth the dev-time savings.

## Compared to v3.1

v3.1 plugins received `ctx.bot`, `ctx.registerCommand`, `ctx.sendMsg` because the bot was in-process. theorchestra splits coordinator and observer: the bot is a separate Claude Code session (OmniClaude), so those hooks don't belong in the observer-side plugin API. Plugins that need to prompt the user write events OmniClaude can interpret; they don't send messages themselves.

If you need a v3.1-style command handler (`/mycommand`), handle it in OmniClaude's CLAUDE.md rules, not in a plugin.
