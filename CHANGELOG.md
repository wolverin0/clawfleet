# Changelog

All notable changes to clawfleet are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-04-14

Initial public release as `clawfleet`. Forked in spirit (not in history) from [wolverin0/wezbridge v3.1](https://github.com/wolverin0/wezbridge) — substrate shared, coordination philosophy replaced.

### Agent-centric orchestration

- **OmniClaude orchestrator** — a persistent Claude Code session is the coordinator, not a Node bot. It discovers panes, watches events, reacts to Telegram, and dispatches A2A messages to peers.
- **Peer-to-peer A2A protocol** — any Claude/Codex pane can send a structured envelope to any other pane via `wezbridge` MCP. Envelopes are `corr`-threaded and carry `request` | `ack` | `progress` | `result` | `error` semantics.
- **Push-vs-watch asymmetry** — responders MUST push `type=progress` every ~3 min and `type=result` on completion (because Codex has no `Monitor` tool, so responders can't assume the requester is watching).
- **Three orchestration layers** — subagent (in-process) vs peer pane same-project vs peer pane cross-project. Agents reading the global instruction files know when to pick which.

### Crash detection & resilience

- **`peer_orphaned` events** — `omni-watcher.cjs` parses A2A envelopes in pane output, tracks pending exchanges by `corr`, and emits a P1 event when a pane dies with unresolved A2A. OmniClaude consumes the event and notifies the surviving peer.
- **`session_stuck` detection** — activity-based hashing of pane output distinguishes "working but silent" from "truly stuck". Configurable threshold.
- **Graceful watcher re-launch** — monitors emit `relaunch_me` at the 55-min mark so OmniClaude re-spawns them before the Monitor-tool 1h hard timeout.

### Telegram live feed

- **One editable message per pane per topic** — `editMessageText` keeps a single live tail in view; doesn't spam the topic with new messages.
- **Auto-topic creation** — new projects get their own forum topic the first time a pane appears there (via `createForumTopic`). Persisted to `~/.omniclaude/telegram-topics.json`.
- **Dense view** — chrome stripping removes status bar, `Ctx:`, spinner lines, box-drawing, ceremonial tool-call acks; long ⎿ tool-result blocks (>3 lines) collapse to a one-line summary + preview. The 40-line live window survives long `ingest_claim` or `query_memory` outputs.
- **Pane identity header** — `[project · agent-model]` (e.g. `[memorymaster · claude-opus]`), disambiguated to `[project-agent · model]` when ≥2 panes share the same project (e.g. `[app-codex · gpt5]` vs `[app-claude · opus]`).
- **User-supplied pane aliases** — `~/.omniclaude/pane-aliases.json` overrides auto-detection, hot-reloaded.

### Active tasks durability

- **`active_tasks.md`** is the single source of truth for in-flight work. Format: `## T-NNN · Title` + fenced YAML block per task.
- **`tasks-watcher.cjs`** emits `task_added`, `task_status_changed`, `task_stuck`, `followups_pending`, `tasks_file_updated`.
- **Contract**: no task without an entry, report = close, read before reply, signals are priority.

### Safety rails

- **`scripts/commit-guard.js`** — PreToolUse hook + git pre-commit hook. Blocks on `main`: ≥4 staged files, infra files (`.env`, `package.json`, docker*, nginx*, *.yml, …), new files, destructive flags (`--no-verify`, `reset --hard`, `push --force`, `rm -rf`, `drop`), cross-module commits. Any non-`main` branch allows everything.
- **No hardcoded secrets** — env-var-only.
- **No silent file corruption** — shared-repo safety recommends `git worktree add` for multi-pane projects and `| owns=<subdir>/` envelope declaration as fallback.

### Known limits (deferred, not blockers)

- **Heartbeat enforcement** — rule exists, no watcher-side silent-peer flag yet.
- **Envelope validation** — malformed envelopes are ignored silently rather than surfaced to the sender.
- **Worktree init script** — shared-repo worktree is recommended, not scripted.
- **Dashboard** — no desktop UI yet (Phase 2).
- **v3.1 features** — permission buttons, voice prompts, project scanner, plugins, /split/workspace/remote, code diffs, GitHub webhooks, PM2, inline mode, ntfy — all on the Phase 3 roadmap.

### Compatibility note

The MCP namespace is **`wezbridge`** (not `clawfleet`) to match the tool name agents call (`mcp__wezbridge__*`). The project is called clawfleet; the MCP tool stays `wezbridge` for backward compatibility with any existing Claude Code sessions that already have it registered.

---

## Pre-v1.0

Pre-rebrand iteration happened in `wolverin0/wezbridge` (v1–v3.1). That repo remains as the historical artifact of the bot-centric architecture and is not part of this changelog.
