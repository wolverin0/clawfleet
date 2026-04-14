# Feature: GitHub webhooks → topic notifications

When a repo emits a webhook (push, PR, issue, release, workflow run), clawfleet formats it into a Telegram-ready HTML chunk and publishes it to the event stream. OmniClaude routes the event to the matching project topic.

## Why agent-centric

The receiver doesn't know which Telegram topic corresponds to each repo. That mapping lives in OmniClaude's config. The receiver emits structured events; OmniClaude decides where they go. This keeps the webhook server reusable (same server could post to Slack, Discord, ntfy, etc. via different consumers).

## What it handles

| GitHub event | Formatted fields | Telegram rendering |
|---|---|---|
| `push` | `branch`, `pusher`, first 5 commits | 🔀 push to `<repo>` · branch … |
| `pull_request` | `action`, `number`, `title`, `merged`, `url` | 🟢/🟡/🔴/🟣 PR <action> · `<repo>`#N |
| `issues` | `action`, `number`, `title`, `user`, `url` | ✅/🟢/🟡 issue <action> · `<repo>`#N |
| `release` | `action`, `tag`, `name`, `url` | 📦 release · `<repo>` |
| `workflow_run` | `name`, `conclusion`, `branch`, `url` | ✅/❌/⚪/⏳ workflow <conclusion> · `<repo>` |
| `ping` | `zen` | 🏓 ping (for the GitHub verify-hook test) |
| anything else | `repo`, raw event name | `<event>` · `<repo>` (no formatter) |

## Setup

1. Generate a random secret:
   ```bash
   openssl rand -hex 32
   ```
2. Add to your env:
   ```bash
   export GITHUB_WEBHOOK_SECRET=<the random value>
   # optional:
   export GITHUB_WEBHOOK_PORT=4180     # default 4180
   export GITHUB_WEBHOOK_PATH=/webhook # default /webhook
   ```
3. Make the port reachable from GitHub. Options:
   - **Cloudflare Tunnel** (recommended, free): `cloudflared tunnel --url http://localhost:4180`
   - **ngrok**: `ngrok http 4180`
   - **Reverse proxy** on your existing public HTTPS (nginx / Caddy)
   - **Local dev**: GitHub doesn't reach localhost, so a tunnel is required
4. Add the webhook in each repo's Settings → Webhooks:
   - Payload URL: `https://<your-public-host>/webhook`
   - Content-Type: `application/json`
   - Secret: the value from step 1
   - Events: "Send me everything" (or pick specific ones)
5. Run the receiver:
   ```bash
   node src/github-webhook.cjs
   ```

## Running modes

### Standalone under PM2

Add to `ecosystem.config.cjs`:

```js
{
  name: 'clawfleet-github-webhook',
  script: 'src/github-webhook.cjs',
  autorestart: true,
  max_memory_restart: '256M',
  restart_delay: 3000,
},
```

### Piped into the plugin-host (so plugins see github events too)

```bash
node src/plugin-host.cjs | …   # plugin-host already fans events to plugins
# separately:
node src/github-webhook.cjs    # emits github events on its own stdout
# — to merge them into one stream, route both into the Monitor:
```

Or just run both processes; Monitor subscribes to each separately.

### Mounted on an existing HTTP server (e.g. dashboard-server)

```js
const githubWebhook = require('./src/github-webhook.cjs');
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/webhook')) return githubWebhook.handleRequest(req, res);
  // … other routes …
});
```

(Future enhancement: dashboard-server could embed this directly if you always want one HTTP surface.)

## Event payload shape

Every emitted event has at least:

```json
{
  "ts": "2026-04-14T03:00:00.000Z",
  "source": "github",
  "event": "push",
  "repo": "wolverin0/clawfleet",
  "html": "🔀 <b>push</b> to <code>wolverin0/clawfleet</code>…",
  "delivery": "abc-123-uuid"
}
```

Event-specific fields are added on top (see the table above).

## OmniClaude integration

Add a project-to-repo map in OmniClaude's config (e.g. `~/.omniclaude/github-repo-topics.json`):

```json
{
  "wolverin0/clawfleet": "clawfleet",
  "wolverin0/wezbridge": "clawfleet",
  "wolverin0/memorymaster": "memorymaster"
}
```

Then in the Event Reaction Tree:

```
+-- source == 'github'   --> 1. topic = repoTopicMap[event.repo]
                             2. if (!topic) skip  (repo not watched)
                             3. reply to topic with event.html
                             4. optionally: ntfy.notify({title, msg: html_to_text(html), priority: 'high'})
                                 for 'workflow_run' conclusion=='failure' and severity=high events
```

## Security notes

- **ALWAYS set `GITHUB_WEBHOOK_SECRET`**. Without it, anyone who discovers your webhook URL can forge events. The receiver falls open (accepts unsigned requests) when the secret is empty — by design, for local-only dev — but the log line at boot flags it loudly.
- Signature verification uses `crypto.timingSafeEqual`.
- Requests with invalid signatures get `401`, malformed JSON gets `400`, wrong path/method gets `404`.
- The receiver does NOT de-dupe by `x-github-delivery`. If GitHub retries a delivery (e.g. network timeout), you'll see the event twice. Add dedup in OmniClaude if it bites.

## Why not use the dashboard-server for this?

We could. But keeping it separate:
- Lets you run the webhook receiver on a different box (security isolation) while the dashboard stays local.
- Means one process per concern → easier PM2 supervision and lower blast radius when something crashes.
- The module exposes `handleRequest` anyway, so mounting it on the dashboard is a 3-line change when you want a unified HTTP surface.

## Failure modes

| Error | Cause | Fix |
|---|---|---|
| `Signature verify FAILED` | wrong secret OR replay attack | rotate secret, update GitHub |
| `JSON parse error` | non-GitHub client hitting the endpoint | usually benign; noise in logs |
| `401 invalid signature` repeats | clock-skew is NOT a factor — HMAC doesn't involve time | regenerate secret on both sides |
| receiver stops on port-in-use | `GITHUB_WEBHOOK_PORT` collision | pick a free port |
