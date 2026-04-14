# Feature: Telegram permission commands

Approve, reject, or always-allow tool-use permission prompts from a Telegram topic without typing `1` / `3` into the pane directly.

## Why this shape (and not inline buttons)

v3.1 of the bot-centric ancestor used Telegram inline keyboards (`[✅ Approve]` / `[❌ Reject]`) for this. That required the bot to own `getUpdates` polling so it could receive `callback_query` updates. In theorchestra, the **Claude Code telegram channel plugin already owns that polling loop** — so any second process calling `getUpdates` on the same bot token would steal updates and break DM routing (see `src/telegram-streamer.cjs` line 599 for the historical note).

Until the channel plugin is patched to forward `callback_query` updates (same pattern as its existing `message_thread_id` forwarding), text commands are the clean path: they flow through the existing message forwarding and need no new polling.

Planned upgrade to inline buttons is in Phase 4 — gated on an upstream plugin patch.

## Flow

```
  ┌──────────────────────┐        session_permission P1 event
  │    pane N (Claude)   │  ──▶  ┌─────────────────────────────┐
  │  "Allow Edit? [1/2/3]│        │  omni-watcher.cjs           │
  └──────────────────────┘        │  emits to Monitor stdout    │
                                   └──────────────┬──────────────┘
                                                  │
                               ┌──────────────────▼──────────────────┐
                               │  OmniClaude reacts:                 │
                               │  • reads prompt text from pane       │
                               │  • calls formatPermissionAlert(…)    │
                               │  • posts to project's Telegram topic │
                               └──────────────────┬──────────────────┘
                                                  │ (user reads on phone)
                                                  │ user types `/approve` in topic
                                                  ▼
                       ┌─────────────────────────────────────────────┐
                       │  channel plugin forwards with               │
                       │  message_thread_id meta                     │
                       └──────────────────┬──────────────────────────┘
                                          │
                 ┌────────────────────────▼────────────────────────┐
                 │  OmniClaude:                                    │
                 │  • parsePermissionCommand(text) → { key: "1" }  │
                 │  • mcp__wezbridge__send_key(paneN, "1")         │
                 │  • reply in topic: "✅ approved"                 │
                 └─────────────────────────────────────────────────┘
```

## Helper module

`src/permission-alerts.cjs` exposes two pure functions:

```js
const { formatPermissionAlert, parsePermissionCommand } = require('./src/permission-alerts.cjs');

// On session_permission event:
const text = formatPermissionAlert({
  paneId: 6,
  projectName: 'app',
  promptPreview: 'Allow Edit on src/auth.go?',
});
// → "🔐 PERMISSION PROMPT — [app] pane-6\n<i>Allow Edit on src/auth.go?</i>\n\nReply in this topic: /approve …"

// On topic reply:
const cmd = parsePermissionCommand(userText);
// → { command: 'approve', key: '1' } | { command: 'always', key: '2' } | { command: 'reject', key: '3' } | null
```

No side effects; safe to import anywhere.

## Commands supported

| Command | Meaning | send_key |
|---------|---------|----------|
| `/approve`, `/yes`, `/si` | allow this one action | `1` |
| `/always` | always allow this kind of action | `2` |
| `/reject`, `/no` | deny this action | `3` |

Case-insensitive. Anything after the verb is ignored (`/approve sure go ahead` works).

## Integration checklist for OmniClaude

Add to your Event Reaction Decision Tree in `omniclaude/CLAUDE.md`:

```
+-- event == "session_permission"   --> 1. read pane prompt via read_output(pane, 20)
                                        2. text = formatPermissionAlert({paneId, projectName, promptPreview})
                                        3. reply to the project's Telegram topic with `text`
                                        4. watch for `/approve|/always|/reject` reply in topic
                                        5. on reply: send_key(pane, <key>) + ack "✅ approved"
```

## Security note

Anyone with access to the Telegram group can type `/approve` in a topic and approve a permission prompt. This is by design — the group is the trust boundary. If the group is shared with untrusted parties, disable this feature in OmniClaude's config (Phase 3 deliverable: per-topic allow-list in `~/.omniclaude/permission-allowlist.json`).

## Future upgrade (Phase 4)

Inline buttons become possible once the telegram channel plugin is patched to forward `callback_query` updates. The helper module is already shaped to plug a second formatter (`formatPermissionAlertWithButtons({paneId, projectName, promptPreview, corr})`) that returns an `{ text, reply_markup }` pair for `sendMessage`; the callback handler reuses the same `parsePermissionCommand` plumbing keyed on `corr`.
