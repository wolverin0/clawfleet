# hello-world plugin

The canonical theorchestra plugin — does nothing useful, but demonstrates every piece of the plugin API in ~20 lines. Read the source in [`index.cjs`](index.cjs) as the primary documentation.

## What it does

- Logs when any Claude/Codex session starts or completes a task.
- Emits a `plugin:hello-world` custom event (`event: "hello"`) so you can see events from plugins appear in the Monitor stream alongside core watcher events.

## Try it

With plugin-host running (via `node src/plugin-host.cjs` or OmniClaude's `Monitor` pointing at it), spawn a new Claude session in any project. You'll see lines like:

```
[plugin-host] 2026-04-14T03:00:00.000Z Loaded plugin "hello-world" from plugins/example/index.cjs
[plugin-host] 2026-04-14T03:01:15.123Z [hello-world] new session in wezbridge (pane 12)
{"ts":"...", "source":"plugin:hello-world", "event":"hello", "pane":12, "project":"wezbridge"}
```

The `plugin:hello-world` line is also visible to downstream subscribers (OmniClaude, the dashboard) because plugin emits flow through the same stdout stream.

## Disable

Rename the folder to `_example/` or delete it. The host reloads its plugin set on restart.
