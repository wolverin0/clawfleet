# Architecture

clawfleet's design choice is **agent-centric orchestration**: a real Claude Code session owns coordination, not a Node bot. Everything else follows from that.

## Process layout

```
 Host OS
  ├─ WezTerm (one process, one mux)
  │   ├─ pane-1  OmniClaude (Claude Code session — the orchestrator)
  │   ├─ pane-N  Worker panes (Claude, Codex, shell, …)
  │   └─ …
  │
  ├─ node src/telegram-streamer.cjs    (standalone process, polls panes → Telegram)
  ├─ node src/omni-watcher.cjs         (spawned by OmniClaude via Monitor tool)
  ├─ node src/tasks-watcher.cjs        (spawned by OmniClaude via Monitor tool)
  ├─ node src/mcp-server.cjs           (per-Claude-session, spawned by the CLI)
  └─ scripts/omniclaude-forever.sh     (keeps OmniClaude pane alive across timeouts)
```

Key decisions:

- **WezTerm as substrate, not as UI** — we use WezTerm because its mux keeps panes alive independently, gives us scrollback via `wezterm cli get-text`, and survives individual process crashes. We don't use WezTerm's GUI features; users can swap it for an equivalent mux (tmux, zellij) if someone contributes the wrapper.
- **Sessions are independent** — OmniClaude can die and its monitors keep running; peer panes can die and OmniClaude keeps running; the streamer can die and the rest keeps running. Every boundary is a process boundary.
- **Stateless coordination** — durable state lives in files (`active_tasks.md`, `~/.omniclaude/telegram-topics.json`, `~/.omniclaude/pane-aliases.json`) and MemoryMaster claims, not in any process's RAM.

## The orchestrator (OmniClaude)

OmniClaude is a Claude Code session running with `claude --continue` in a dedicated pane, driven by `scripts/omniclaude-forever.sh`. It owns:

- Event reaction via `Monitor` tool (P0/P1/P2 handling, `session_stuck`, `session_permission`, `peer_orphaned`, `followups_pending`).
- Telegram read feed (listens on the DM topic; replies to the same thread it came from).
- `active_tasks.md` maintenance.
- MemoryMaster claim ingestion.
- Dispatch of A2A messages when another pane needs nudging (orphaned peer notification, stuck task escalation).

OmniClaude NEVER edits code in other projects. For code work, it sends an A2A request to the pane that owns that project.

## The watchers

**`omni-watcher.cjs`** polls WezTerm every 30s. Per pane it:

1. Detects Claude/Codex identity (title glyphs, Ctx status bar, gpt-X substring).
2. Classifies status (idle / working / permission / stuck) via anchored spinner regex on the last 30 lines.
3. Emits transition events (`session_started`, `session_completed`, `session_permission`, `session_stuck`).
4. Parses token metrics from the status bar.
5. **Scans A2A envelopes** and updates the `pendingA2A` map keyed by `corr`.
6. On `session_removed`, emits `peer_orphaned` P1 for any surviving partner of an unresolved `corr`.

Poll interval was deliberately raised to 30s: 5s saturated the WezTerm socket and crashed the GUI (see CHANGELOG for the incident).

**`tasks-watcher.cjs`** watches `active_tasks.md` for:

- `task_added` / `task_status_changed`
- `task_stuck` (activity-based hash on the owner pane's tail)
- `followups_pending` (closed tasks with `follow_ups:` not yet dispatched)
- `tasks_file_updated`

Tasks watcher is the enforcement layer for the active-tasks contract: no task without an entry, report = close, read before reply, signals are priority.

## The streamer

`telegram-streamer.cjs` is a standalone Node process (not spawned by OmniClaude — it runs under `omniclaude-forever.sh` directly). For each Claude/Codex pane it detects:

1. Polls the pane's output every 5s.
2. Strips chrome: status bar, Ctx lines, spinner lines, box-drawing, ceremonial tool-call acks.
3. Collapses `⎿` tool-result blocks longer than 3 lines into `⎿ [N lines] <preview>`.
4. Renders last 40 lines as `<pre><code class="language-bash">` for Telegram.
5. `editMessageText` on the topic's existing message — no new-message spam.
6. Auto-creates forum topics for new projects via `createForumTopic` and persists to `~/.omniclaude/telegram-topics.json`.

## A2A protocol

Every peer-to-peer message uses a parseable envelope header. The full spec is in [`a2a-protocol.md`](a2a-protocol.md). Summary:

- Envelope: `[A2A from pane-<N> to pane-<M> | corr=<id> | type=request|ack|progress|result|error]`
- Sender: `mcp__wezbridge__send_prompt(target, "[A2A …]\n<body>")` **followed by** `mcp__wezbridge__send_key(target, "enter")`.
- Receiver: reads the envelope, threads replies on the same `corr`, pushes `progress` during long work and `result` on completion.
- Observability: `omni-watcher.cjs` tracks open exchanges; OmniClaude notifies survivors when one side dies.

## Safety rails

- **`scripts/commit-guard.js`** blocks risky commits on `main` (new files, infra files, cross-module, destructive flags). Runs as both a PreToolUse hook in Claude Code and a git pre-commit hook.
- **Envelope-aware observation** — malformed A2A messages still work as prose but won't be tracked (validation layer is on the Phase 3 roadmap).
- **Worktree recommendation** — when 2+ peer panes share a repo cwd, use `git worktree add` or declare `| owns=<subdir>/` in the envelope to avoid silent last-write-wins.

## What's deliberately NOT in clawfleet

- **In-process bot UI** — the v3.1 ancestor embedded a Telegram bot + web dashboard in the same process. clawfleet splits them: the streamer is read-only, Telegram inbound is OmniClaude's job, and the dashboard (Phase 2) will be a separate frontend hitting a thin HTTP layer.
- **Plugin system inside the bot** — v3.1 had `plugins/*.cjs` with a context API. Under the agent-centric model, "plugins" are just additional Claude/Codex panes with project-specific roles — the protocol is the API.
- **Monolithic state** — no single process owns "the world". State is files + MemoryMaster.

## Glossary

- **pane** — a WezTerm pane running a process (Claude Code, Codex CLI, bash, etc).
- **peer pane** — a pane reachable from another pane via `wezbridge` MCP.
- **envelope** — the A2A message header with `from`, `to`, `corr`, `type`.
- **corr** — correlation id threading a request and its reply(ies).
- **orphaned peer** — a pane whose A2A partner died before resolving the exchange.
- **OmniClaude** — the orchestrator Claude Code session; always in pane 1 by convention.
