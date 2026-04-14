#!/usr/bin/env node
/**
 * ntfy.sh backup notification channel.
 *
 * ntfy.sh is a free, no-auth push-notification service. Usage pattern in
 * theorchestra: belt-and-suspenders alerting when Telegram is unavailable
 * (rate-limited, bot down, user has DND on). OmniClaude (or any watcher)
 * calls this for P0/P1 events so you get a phone push even when Telegram
 * is silent.
 *
 * Two modes:
 *  - public topic (default): POST https://ntfy.sh/<topic>
 *    anyone with the topic name can read. Fine for non-sensitive alerts.
 *  - self-hosted or authenticated: set NTFY_SERVER + NTFY_TOKEN env vars.
 *
 * Config via env:
 *   NTFY_TOPIC       — the topic name (required to enable ntfy).
 *   NTFY_SERVER      — default 'https://ntfy.sh'
 *   NTFY_TOKEN       — optional bearer token for private instances.
 *
 * Exports:
 *   isEnabled() -> boolean
 *   notify({ title, message, priority, tags, click, actions }) -> Promise<boolean>
 *
 * CLI:
 *   node src/ntfy-notifier.cjs "Title" "Message body" [priority]
 *     priority: min, low, default, high, urgent
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

function config() {
  const topic  = process.env.NTFY_TOPIC;
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const token  = process.env.NTFY_TOKEN || null;
  return { topic, server, token };
}

function isEnabled() {
  return !!config().topic;
}

/** POST a ntfy notification. Returns true on success, false on failure. */
function notify({ title, message, priority = 'default', tags = [], click, actions } = {}) {
  return new Promise((resolve) => {
    const cfg = config();
    if (!cfg.topic) return resolve(false);

    const url = new URL(`/${encodeURIComponent(cfg.topic)}`, cfg.server);
    const body = typeof message === 'string' ? message : JSON.stringify(message ?? '');
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (title) headers['Title'] = title;
    if (priority) headers['Priority'] = priority;
    if (tags && tags.length) headers['Tags'] = tags.join(',');
    if (click) headers['Click'] = click;
    if (actions) headers['Actions'] = typeof actions === 'string' ? actions : JSON.stringify(actions);
    if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
    headers['Content-Length'] = Buffer.byteLength(body);

    const client = url.protocol === 'http:' ? http : https;
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname,
      method: 'POST',
      headers,
    }, (res) => {
      let _ = '';
      res.on('data', c => { _ += c; });
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

module.exports = { isEnabled, notify };

// ── CLI ──
if (require.main === module) {
  const [, , title, message, priority] = process.argv;
  if (!isEnabled()) {
    process.stderr.write('ntfy disabled: set NTFY_TOPIC env var first\n');
    process.exit(1);
  }
  if (!message) {
    process.stderr.write('usage: node src/ntfy-notifier.cjs "Title" "Body" [priority]\n');
    process.exit(1);
  }
  notify({ title, message, priority: priority || 'default' }).then(ok => {
    process.stdout.write(ok ? 'ok\n' : 'failed\n');
    process.exit(ok ? 0 : 2);
  });
}
