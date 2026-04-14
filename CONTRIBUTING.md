# Contributing to clawfleet

Thanks for wanting to help. clawfleet is young — there's a lot of room for contribution in all three phases (core, dashboard, v3.1 feature rescue).

## Dev setup

1. Install prerequisites:
   - [WezTerm](https://wezfurlong.org/wezterm/) with mux server
   - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
   - (optional) [Codex CLI](https://github.com/openai/codex) to test cross-LLM
   - Node.js 18+
   - A Telegram bot (`@BotFather`) and a group with Topics enabled (optional, for the streamer)
2. Fork and clone:
   ```bash
   git clone https://github.com/<your-user>/clawfleet.git
   cd clawfleet
   npm install
   cp env.sample .env
   # edit with your bot token + group ID if you want live streaming
   ```
3. Register the MCP server in your local Claude Code:
   ```bash
   claude mcp add wezbridge --scope user -- node $(pwd)/src/mcp-server.cjs
   ```
4. Launch an OmniClaude pane in WezTerm with:
   ```bash
   bash scripts/omniclaude-forever.sh
   ```
5. (Optional) Start the Telegram streamer:
   ```bash
   node src/telegram-streamer.cjs
   ```

## How to test changes

- **Watcher / streamer**: each module is a plain Node process. `node --check src/<file>.cjs` catches syntax issues. Unit-test extracted helpers with small Node scripts in `scripts/.*-test.cjs` (see how `detectProject`, `collapseToolResults`, `scanA2AEnvelopes` are tested).
- **MCP server**: spawn a fresh Claude Code session after registering, ask it to `discover_sessions` — you should see your WezTerm panes.
- **A2A protocol**: spawn two panes in the same project, send a `[A2A from pane-A to pane-B | corr=TEST | type=request]` envelope via `send_prompt` + `send_key("enter")`, verify the peer replies with `type=result`.

## Commit conventions

Conventional Commits:
- `feat:` new user-facing feature
- `fix:` bug fix
- `refactor:` internal reshape without behavior change
- `docs:` docs only
- `test:` tests only
- `chore:` tooling, deps, rebrand, non-code

One logical change per commit. For multi-file changes on `main`, the `scripts/commit-guard.js` hook may block you — use a feature branch.

## Branch naming

- `feat/<scope>-<short-name>` — new feature
- `fix/<scope>-<short-name>` — bug fix
- `a2a/<topic>` — A2A protocol evolution
- `clawfleet/<topic>` — meta / rebrand / release work

## Code style

- CommonJS (`.cjs`) for Node modules (matches existing files).
- Files under 800 lines, functions under 50 lines, nesting under 4 levels.
- Immutable where possible — prefer returning new objects over mutating.
- No hardcoded secrets (use env vars).
- Validate user input at boundaries (Telegram messages, MCP args, shell commands).
- Comments only when the **why** is non-obvious. Don't narrate what the code does.

## Pull request checklist

- [ ] Tests exist for new helper logic (extract + unit-test the way `detectProject` does it)
- [ ] `node --check` passes on any modified `.cjs`
- [ ] Existing `active_tasks.md` contract preserved (for watcher changes)
- [ ] Global CLAUDE.md / AGENTS.md protocol unchanged, or change explained in PR body
- [ ] README / CHANGELOG updated for user-visible behavior
- [ ] No secrets, tokens, private paths, or screenshots with sensitive data

## Filing issues

- **Bug**: include WezTerm version, Node version, Claude Code version, and the last 30 lines of the watcher's stderr. If the Telegram streamer is involved, include which topic + which pane.
- **Feature**: describe what problem it solves first, implementation ideas second.

## Phase roadmap for contributors

We're early. Good first issues are likely in:

- **Phase 2 — desktop dashboard** (Vite + React). Start from scratch, pane grid is the highest-ROI panel.
- **Phase 3 — v3.1 feature rescue**:
  - Permission buttons in Telegram
  - Project scanner
  - Voice prompts (Whisper)
  - Plugin system
  - …(see the Roadmap in README.md)

Each Phase 3 feature is ~1-4h of work. Pick one, file an issue ("Port voice prompts from v3.1"), link the source file in `wolverin0/wezbridge` for reference, and go.

## License

By contributing, you agree your changes are licensed under MIT (same as the rest of the project).
