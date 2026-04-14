# Features: ntfy.sh backup channel + PM2 process supervision

Two small operational features shipped together.

## ntfy.sh backup notification channel

`src/ntfy-notifier.cjs` is a ~70-LOC Node stdlib wrapper around ntfy.sh — the free, no-auth push-notification service. Purpose: **belt-and-suspenders alerts**. When Telegram is rate-limited, the bot is down, or the user has DND on the chat, a ntfy notification still hits the phone.

### Setup

1. Pick a unique topic name (think of it as a shared secret — anyone with the name can read it):
   ```bash
   export NTFY_TOPIC="theorchestra-alerts-<random-suffix>"
   ```
2. Install the ntfy app on your phone and subscribe to that topic.
3. (Optional) Self-host: `export NTFY_SERVER="https://ntfy.yourdomain.tld"`.
4. (Optional) Private instance: `export NTFY_TOKEN="…"` for bearer auth.

### Usage

```js
const ntfy = require('./src/ntfy-notifier.cjs');
if (ntfy.isEnabled()) {
  await ntfy.notify({
    title: 'peer_orphaned',
    message: 'pane-6 died with pending A2A corr=T-012',
    priority: 'high',    // min|low|default|high|urgent
    tags: ['warning', 'a2a'],
    click: 'https://dashboard.local/panes',  // phone opens this on tap
  });
}
```

CLI:
```bash
node src/ntfy-notifier.cjs "Title" "Message body" high
```

### OmniClaude integration

Mirror P0 and P1 events from the watcher to ntfy as well as Telegram:

```
+-- severity == "P0"   --> ntfy({ title, priority: 'urgent' })  AND Telegram DM
+-- severity == "P1"   --> ntfy({ title, priority: 'high' })    AND Telegram topic
```

Graceful degradation: if `NTFY_TOPIC` is unset, `notify()` returns false instantly without side effects, so it's safe to always-call.

## PM2 process supervision

`ecosystem.config.cjs` defines production process groups:

| App | Script | Purpose |
|-----|--------|---------|
| `theorchestra-streamer` | `src/telegram-streamer.cjs` | live Telegram feed per pane |
| `theorchestra-dashboard` | `src/dashboard-server.cjs` | web UI backend on port 4200 |
| `theorchestra-watcher` (commented) | `src/omni-watcher.cjs` | optional headless watcher — usually owned by OmniClaude's Monitor tool instead |

OmniClaude itself stays OUT of PM2 — it's a Claude Code session running in a WezTerm pane, owned by the human via `scripts/omniclaude-forever.sh`. PM2 manages the headless Node processes, not the TUI.

### Commands

```bash
npm install -g pm2

# First-time start
pm2 start ecosystem.config.cjs

# Status / logs
pm2 status
pm2 logs theorchestra-streamer
pm2 logs theorchestra-dashboard --lines 100

# Persist across reboot
pm2 save
pm2 startup     # run the command it prints (sudo)

# Restart after editing config
pm2 reload ecosystem.config.cjs

# Stop everything
pm2 stop all
pm2 delete all
```

### Why PM2 and not systemd / Docker?

Historical: v3.1 shipped PM2 config because its user base was mostly running on Windows and personal Linux boxes where systemd is overkill. Same rationale applies. If you prefer systemd, the `ecosystem.config.cjs` is trivially translated to a `.service` file per app — there's no PM2-specific behavior required.

### Memory limits

Each app has `max_memory_restart: '512M'`. Streamer typically sits around 100MB; the dashboard under 150MB; watcher under 80MB. The 512MB cap catches leaks rather than normal usage — if you see repeated restarts in `pm2 status`, raise the limit or file a bug.
