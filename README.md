# clawfleet

**Multi-agent orchestrator for Claude Code and Codex sessions, with WezTerm panes as the substrate.**

clawfleet lets you run many long-lived AI coding sessions in parallel — each in its own WezTerm pane — and gives them a shared protocol to talk to each other, a shared watcher for crash and silence detection, and a Telegram feed so you can read what they're doing from your phone.

```
     ┌──────────────────────────────────────────────────────────┐
     │                      WezTerm (mux)                       │
     │                                                          │
     │  pane-1 OmniClaude   pane-6 Codex       pane-8 Claude    │
     │   (orchestrator) ──▶ (app / lead)   ◀──▶ (app / peer)    │
     │        ▲                │                   │            │
     │        │                └─── A2A envelope ──┘            │
     │        │              via mcp__wezbridge__send_prompt    │
     └────────┼──────────────────────────────────────────────────┘
              │
              ├─ omni-watcher ─────▶ stdout events (Monitor)
              ├─ tasks-watcher ────▶ active_tasks.md signals
              └─ telegram-streamer ▶ live feed per pane → Telegram topic
```

## Why clawfleet is different

| | Bot-centric (typical Telegram-Claude bridges) | Agent-centric (clawfleet) |
|---|---|---|
| Coordinator | Node bot monolith | A real Claude Code session (`OmniClaude`) |
| Message passing | Bot → session, one direction | Peer ↔ peer via wezbridge MCP + envelope protocol |
| Multi-LLM | Single provider | Claude + Codex in the same swarm |
| Crash isolation | Bot crash = total outage | One pane dies, peers and orchestrator survive |
| State durability | In-memory | `active_tasks.md` + MemoryMaster claims |
| Cross-session memory | Per-session | Cross-session via MemoryMaster MCP (optional) |

clawfleet is for workflows where the AI sessions need to talk to each other, survive restarts, and keep working while you're asleep.

## Core pieces

| File | What it does |
|------|--------------|
| `src/mcp-server.cjs` | MCP server exposing `wezbridge` tools (`discover_sessions`, `send_prompt`, `send_key`, `read_output`, `spawn_session`, `kill_session`, …) |
| `src/wezterm.cjs` | Wrapper around `wezterm cli` — pane spawning, text injection, scrollback reads, socket discovery |
| `src/pane-discovery.cjs` | Claude/Codex pane detection, status classification (idle / working / permission / stuck) |
| `src/omni-watcher.cjs` | Event stream over `Monitor`: session state changes, metrics, A2A envelope tracking, `peer_orphaned` emission on crash |
| `src/tasks-watcher.cjs` + `src/task-parser.cjs` | Watches `active_tasks.md` for follow-ups, stuck tasks, status transitions |
| `src/telegram-streamer.cjs` | Streams each pane's live output to a Telegram forum topic. Dense view (chrome-stripped, tool-result collapsed, agent-model identity) |
| `scripts/commit-guard.js` | PreToolUse + git pre-commit hook that blocks risky commits on `main` (new files, infra files, cross-module, destructive flags) |
| `scripts/omniclaude-forever.sh` | Launches the orchestrator pane with `claude --continue` + auto-restart on timeout |

## A2A protocol at a glance

Every peer-to-peer message uses an envelope header, parseable by regex, threadable by `corr`:

```
[A2A from pane-<N> to pane-<M> | corr=<id> | type=request|ack|progress|result|error]
<body>
```

Hard rules (mandatory for every Claude/Codex session):

1. **Always follow `send_prompt` with `send_key("enter")`.** Enter after typing is unreliable.
2. **Never send bash via `send_text` into a running TUI.** Your text becomes a user prompt, not a shell command.
3. **Every responder MUST push** `type=progress` every ~3 min during long work and `type=result` on completion. Codex cannot `Monitor`; Claude can.

Full spec in [`docs/a2a-protocol.md`](docs/a2a-protocol.md).

## Three orchestration layers

Agents reading their global instructions (`~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`) learn when to pick what:

| Layer | Cost | Lifetime | Use for |
|---|---|---|---|
| Subagent (in-process) | cheap | dies with parent | tight loop, one-turn fan-out |
| Peer pane (same project) | medium | survives parent | long work, cross-LLM, resilience |
| Peer pane (cross-project) | medium | survives | ask another project's specialist |

## Quick start

**Prerequisites:**
- [WezTerm](https://wezfurlong.org/wezterm/) with mux server enabled
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- (Optional) [Codex CLI](https://github.com/openai/codex) for cross-LLM swarms
- Node.js 18+
- A Telegram bot token + a group with **Topics enabled** (for the streamer)

**Install:**
```bash
git clone https://github.com/wolverin0/clawfleet.git
cd clawfleet
npm install
cp env.sample .env     # edit with your bot token + group ID
```

**Register the MCP server** (global, so every Claude Code session can use it):
```bash
claude mcp add wezbridge --scope user -- node $(pwd)/src/mcp-server.cjs
```

**Launch the orchestrator** (OmniClaude):
```bash
bash scripts/omniclaude-forever.sh
```

This starts a persistent `claude --continue` session that will:
1. Spawn `omni-watcher`, `tasks-watcher`, and any project-specific monitors
2. Discover existing Claude/Codex panes
3. Respond to Telegram messages and A2A messages from peer panes

**Start the live Telegram streamer** (separate process):
```bash
node src/telegram-streamer.cjs
```

## Install via agent (experimental)

Paste this prompt into any Claude Code session to auto-install clawfleet:

> You are being installed as a clawfleet orchestrator. Clone https://github.com/wolverin0/clawfleet to `~/clawfleet/`, run `npm install`, copy the sample config, register the `wezbridge` MCP server with `claude mcp add wezbridge --scope user -- node ~/clawfleet/src/mcp-server.cjs`, create `~/.omniclaude/telegram-topics.json` from the template in the repo, launch `Monitor` with `node ~/clawfleet/src/omni-watcher.cjs`, and greet the user on Telegram with a one-liner. Report done.

(This is a v1.0 stub — proper install agent coming in Phase 2.)

## Roadmap

- **Phase 2 — desktop dashboard** (Vite + React) — **shipped in v1.1**. See `dashboard/README.md` for dev/build instructions. Pane grid + SSE events stream + tasks panel. A2A flow panel and claims feed still pending.
- **Phase 3 — port v3.1 features** to the agent-centric architecture:
  - Permission buttons in Telegram (approve/reject tool use)
  - Voice prompts (Whisper transcription)
  - Project scanner (spawn any Claude project from chat)
  - Photo/document support
  - Plugin system (`plugins/*.cjs` with context API)
  - `/split`, `/workspace`, `/remote` (SSH)
  - Code diffs post-response
  - GitHub webhooks → topic notifications
  - PM2 process supervision + log rotation
  - Inline mode (`@clawfleet_bot`)
  - ntfy.sh backup channel
- **Phase 4 — Telegram Mini App dashboard** (port of v3.1's 4-tab mobile UI, adapted to agent-centric model).

## History

clawfleet forks from [wolverin0/wezbridge v3.1](https://github.com/wolverin0/wezbridge) — a bot-centric Telegram ↔ Claude Code bridge. The substrate (WezTerm mux, pane discovery, MCP tools) is shared. The coordination philosophy is not: clawfleet replaces the Node bot monolith with a real Claude Code session as the orchestrator and adds a peer-to-peer A2A protocol so sessions can coordinate directly.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](LICENSE).
