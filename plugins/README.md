# theorchestra plugins

Each subdirectory of this folder is a user-supplied plugin that hooks into watcher events. Plugins run inside `src/plugin-host.cjs` — a sibling process that spawns the watcher as its child, forwards every event unchanged, AND fans events out to subscribed plugins.

See [`docs/plugins.md`](../docs/plugins.md) for the full API.

## Layout

```
plugins/
├── README.md        ← this file
├── example/         ← the hello-world plugin (always present)
│   ├── index.cjs    ← entry point (must export { name, register })
│   └── README.md
└── <your-plugin>/
    └── index.cjs
```

A plugin can also be a bare `.cjs` file at this level — `plugins/my-plugin.cjs` works identically to `plugins/my-plugin/index.cjs`.

## Enabling / disabling

- Files or dirs starting with `_` or `.` are ignored by the loader — handy for "draft" plugins.
- To disable a shipped plugin, rename it to `_plugin-name/`.
- To load plugins from a different directory (e.g. per-project), set:

  ```bash
  THEORCHESTRA_PLUGINS=/path/to/my-plugins node src/plugin-host.cjs
  ```

  Multiple paths separated by `:` (or `;` on Windows).

## Why not modify the watcher directly?

`omni-watcher.cjs` is part of the theorchestra core and upgraded in new releases. Putting user hooks in plugins keeps the core upgrade-safe and sandboxable — a buggy plugin throws a caught exception, doesn't crash the watcher.

## What plugins CANNOT do (by design)

- Post to Telegram — that's OmniClaude's domain. Plugins should `emit` events; OmniClaude reacts and decides whether to message the user.
- Mutate pane state directly (send_prompt, send_key, kill) — same reason. Emit an event with a recommendation; OmniClaude is the decision point.
- Read secrets from env — the host does not pass `process.env` into the plugin context.

If you need one of those capabilities, write a regular Node service instead of a plugin — theorchestra plugins are deliberately a read/observe/emit boundary.
