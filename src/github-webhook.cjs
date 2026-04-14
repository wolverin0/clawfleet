#!/usr/bin/env node
/**
 * GitHub webhook receiver → theorchestra event stream.
 *
 * Small HTTP server (Node stdlib only) that listens for GitHub webhook
 * POSTs, verifies the X-Hub-Signature-256 HMAC, formats the event into a
 * Telegram-ready HTML chunk, and emits it to stdout as a theorchestra event
 * — same JSON-per-line pattern as omni-watcher.
 *
 * Agent-centric: this process does NOT post to Telegram. It emits events
 * like `{ source:'github', event:'push', repo, branch, html, raw }`.
 * OmniClaude (or any other subscriber, including plugin-host) consumes
 * the event and decides how to surface it.
 *
 * Run under PM2, under OmniClaude's Monitor, or piped into the plugin-host.
 *
 * Config via env:
 *   GITHUB_WEBHOOK_PORT    — default 4180
 *   GITHUB_WEBHOOK_SECRET  — optional HMAC secret (strongly recommended;
 *                            if unset, signatures are NOT verified and any
 *                            client can POST events — use only in private
 *                            networks)
 *   GITHUB_WEBHOOK_PATH    — default '/webhook'
 *
 * Exposes a small module API so callers can mount the handler on an
 * existing HTTP server (e.g. dashboard-server):
 *   handleRequest(req, res)  — plug into any http server
 *   verifySignature(body, signatureHeader) -> bool
 *   formatEvent(eventName, payload) -> { event, html, ...fields }
 */

const http = require('http');
const crypto = require('crypto');

const PORT    = parseInt(process.env.GITHUB_WEBHOOK_PORT || '4180', 10);
const SECRET  = process.env.GITHUB_WEBHOOK_SECRET || '';
const WH_PATH = process.env.GITHUB_WEBHOOK_PATH   || '/webhook';

function emit(event) {
  try { process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), source: 'github', ...event }) + '\n'); }
  catch { /* stdout closed */ }
}
function log(msg) {
  process.stderr.write(`[github-webhook] ${new Date().toISOString()} ${msg}\n`);
}
function esc(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function verifySignature(bodyBuf, headerVal) {
  if (!SECRET) return true;              // no secret configured → fail open (see doc warning)
  if (!headerVal) return false;
  const sig = headerVal.replace(/^sha256=/, '');
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(bodyBuf);
  const expected = hmac.digest('hex');
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// ── Event formatters ──────────────────────────────────────────────────────

function formatPush(p) {
  const repo   = p.repository?.full_name || 'unknown';
  const branch = (p.ref || '').replace('refs/heads/', '');
  const pusher = p.pusher?.name || p.sender?.login || 'unknown';
  const commits = Array.isArray(p.commits) ? p.commits : [];
  const body = commits.slice(0, 5).map(c => {
    const subj = (c.message || '').split('\n')[0].slice(0, 60);
    return `  <code>${c.id.slice(0, 7)}</code> ${esc(subj)}`;
  }).join('\n');
  const more = commits.length > 5 ? `\n  <i>…and ${commits.length - 5} more</i>` : '';
  const html = [
    `🔀 <b>push</b> to <code>${esc(repo)}</code>`,
    `branch <code>${esc(branch)}</code> · ${esc(pusher)} · ${commits.length} commit${commits.length === 1 ? '' : 's'}`,
    body || '<i>(no commit list)</i>',
  ].join('\n') + more;
  return { event: 'push', repo, branch, commits: commits.length, pusher, html };
}

function formatPullRequest(p) {
  const action = p.action || 'updated';
  const pr = p.pull_request || {};
  const repo = p.repository?.full_name || 'unknown';
  const user = pr.user?.login || 'unknown';
  const merged = pr.merged ? ' (merged)' : '';
  const icon = pr.merged ? '🟣' : (action === 'closed' ? '🔴' : (action === 'opened' ? '🟢' : '🟡'));
  const html = [
    `${icon} <b>PR ${esc(action)}${merged}</b> · <code>${esc(repo)}</code>#${pr.number}`,
    `${esc(pr.title)} · by ${esc(user)}`,
    pr.html_url ? `<a href="${esc(pr.html_url)}">open on GitHub</a>` : '',
  ].filter(Boolean).join('\n');
  return { event: 'pull_request', action, repo, number: pr.number, title: pr.title, user, merged: !!pr.merged, url: pr.html_url, html };
}

function formatIssues(p) {
  const action = p.action || 'updated';
  const issue = p.issue || {};
  const repo = p.repository?.full_name || 'unknown';
  const user = issue.user?.login || 'unknown';
  const icon = action === 'closed' ? '✅' : (action === 'opened' ? '🟢' : '🟡');
  const html = [
    `${icon} <b>issue ${esc(action)}</b> · <code>${esc(repo)}</code>#${issue.number}`,
    `${esc(issue.title)} · by ${esc(user)}`,
    issue.html_url ? `<a href="${esc(issue.html_url)}">open on GitHub</a>` : '',
  ].filter(Boolean).join('\n');
  return { event: 'issues', action, repo, number: issue.number, title: issue.title, user, url: issue.html_url, html };
}

function formatRelease(p) {
  const action = p.action || 'published';
  const rel = p.release || {};
  const repo = p.repository?.full_name || 'unknown';
  const html = [
    `📦 <b>release ${esc(action)}</b> · <code>${esc(repo)}</code>`,
    `<b>${esc(rel.tag_name || '(no tag)')}</b> — ${esc(rel.name || '')}`,
    rel.html_url ? `<a href="${esc(rel.html_url)}">release notes</a>` : '',
  ].filter(Boolean).join('\n');
  return { event: 'release', action, repo, tag: rel.tag_name, name: rel.name, url: rel.html_url, html };
}

function formatWorkflowRun(p) {
  const wr = p.workflow_run || {};
  const repo = p.repository?.full_name || 'unknown';
  const concl = wr.conclusion || wr.status || 'in_progress';
  const icon = concl === 'success' ? '✅' : concl === 'failure' ? '❌' : concl === 'cancelled' ? '⚪' : '⏳';
  const html = [
    `${icon} <b>workflow ${esc(concl)}</b> · <code>${esc(repo)}</code>`,
    `${esc(wr.name || '?')} · run #${wr.run_number || '?'} · ${esc(wr.head_branch || '?')}`,
    wr.html_url ? `<a href="${esc(wr.html_url)}">open run</a>` : '',
  ].filter(Boolean).join('\n');
  return { event: 'workflow_run', repo, name: wr.name, conclusion: concl, branch: wr.head_branch, url: wr.html_url, html };
}

function formatEvent(eventName, payload) {
  switch (eventName) {
    case 'push':         return formatPush(payload);
    case 'pull_request': return formatPullRequest(payload);
    case 'issues':       return formatIssues(payload);
    case 'release':      return formatRelease(payload);
    case 'workflow_run': return formatWorkflowRun(payload);
    case 'ping':         return { event: 'ping', zen: payload.zen, html: `🏓 ping · ${esc(payload.zen || '')}` };
    default:
      return {
        event: eventName,
        repo: payload.repository?.full_name || null,
        html: `<b>${esc(eventName)}</b> · <code>${esc(payload.repository?.full_name || '?')}</code> (no formatter)`,
      };
  }
}

// ── HTTP handler ──────────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (req.url !== WH_PATH || req.method !== 'POST') {
    res.writeHead(404); return res.end();
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const eventName = req.headers['x-github-event'] || 'unknown';
    const signature = req.headers['x-hub-signature-256'];
    const delivery  = req.headers['x-github-delivery'] || null;

    if (!verifySignature(body, signature)) {
      log(`Signature verify FAILED for ${eventName} delivery=${delivery}`);
      res.writeHead(401); return res.end('invalid signature');
    }

    let payload;
    try { payload = JSON.parse(body.toString('utf8')); }
    catch (err) {
      log(`JSON parse error: ${err.message}`);
      res.writeHead(400); return res.end('invalid JSON');
    }

    const formatted = formatEvent(eventName, payload);
    emit({ ...formatted, delivery });

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  req.on('error', err => {
    log(`request error: ${err.message}`);
    res.writeHead(500); res.end();
  });
}

module.exports = { handleRequest, verifySignature, formatEvent };

// ── Standalone server ──────────────────────────────────────────────────────
if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    log(`listening on http://0.0.0.0:${PORT}${WH_PATH}`);
    log(`secret: ${SECRET ? '(set)' : '(NONE — signature verify disabled, insecure)'}`);
    emit({ event: 'started', port: PORT, path: WH_PATH, has_secret: !!SECRET });
  });
  process.on('SIGTERM', () => { log('SIGTERM'); server.close(() => process.exit(0)); });
  process.on('SIGINT', () => { log('SIGINT'); server.close(() => process.exit(0)); });
}
