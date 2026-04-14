# Feature: Diff reporter (code diffs post-response)

Post a compact "what changed" summary to a pane's Telegram topic whenever the pane's session completes a task.

## Why

v3.1 shipped diffs after every Claude response. That was noisy and sometimes contained large unreviewed code snippets in chat. theorchestra ports the useful part (knowing what changed, at a glance) and drops the noisy part (raw diffs inline).

Output is a compact stat + top-8 files breakdown. To see the actual diff a user opens the pane or the web dashboard.

## Module

`src/diff-reporter.cjs` exposes three pure-ish functions:

```js
const { getRepoStatus, getDiffSummary, getRecentCommits } = require('./src/diff-reporter.cjs');

// Are there changes at all?
const st = getRepoStatus(cwd);
// → { root, branch, clean, staged: [{status,file}], unstaged: [{status,file}] }

// Compact Telegram-ready summary (or null when clean / not a repo).
const ds = getDiffSummary(cwd, { includeStaged: true, maxFiles: 8 });
// → { summary, files, top, html, plain, branch, clean }
//   summary: "3 files changed, +45 -12 on main"
//   html:    Telegram-HTML with <code> per file
//   plain:   terminal/markdown equivalent

// Recent commits for context.
const commits = getRecentCommits(cwd, 5);
// → [{ sha, subject, author, ts }, …]
```

Read-only. No writes. Safe to call on any cwd.

## CLI

```bash
node src/diff-reporter.cjs                   # summary of current dir
node src/diff-reporter.cjs /path/to/project  # specific project
node src/diff-reporter.cjs --json            # machine-readable
```

## OmniClaude integration

Add to the Event Reaction Decision Tree:

```
+-- event == "session_completed"  --> 1. const pane = lookup(event.pane)
                                      2. const ds = diffReporter.getDiffSummary(pane.cwd)
                                      3. if (ds && !ds.clean):
                                         send_prompt? No — POST to Telegram topic.
                                         mcp__plugin_telegram_telegram__reply({
                                           chat_id: GROUP_ID,
                                           message_thread_id: topics[pane.project],
                                           text: `🔧 <b>post-task diff</b>\n${ds.html}`,
                                         })
                                      4. if ds.clean: skip (no message = less noise)
```

## Filtering to avoid noise

Don't post for every tiny session_completed. Heuristics:

- **Only if ≥2 files changed** OR combined +/- > 20 — skip trivial edits.
- **Skip `.md`-only changes** if they're just typos — optional per-project toggle.
- **Rate-limit**: one diff post per pane per 10 min. Store last-posted ts in OmniClaude memory.

## Output example

Telegram HTML (what the user sees):

```
🔧 post-task diff
3 files changed, +45 -12 on main
● src/mcp-server.cjs  +30 -5
○ docs/features/diff-reporter.md  +85 -0
○ CHANGELOG.md  +4 -0
```

(`●` = staged, `○` = unstaged.)

## Security note

The diff command runs in the pane's `cwd`. If the cwd is outside your own repo hierarchy (e.g. a remote-mounted path), `git` will still operate on it — consider a per-project allow-list if you spawn sessions in untrusted dirs.

## Not in this MVP

- **Per-file diff display** — currently only stat + file list. For full diffs, use the web dashboard's file viewer (Phase 2 has the stub).
- **Line-level annotation back into the pane** — too noisy for the Telegram surface.
- **PR-style comment-thread integration** — Phase 3+ (GitHub webhooks deliverable).
