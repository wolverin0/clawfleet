# Changelog

All notable changes to theorchestra are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.1.0] - 2026-04-14

### Major — v3.1 visual port + A2A arrows + toasts + sounds

After v2.0 user feedback ("es un asco" vs the v3.1 ancestor), a full aesthetic port of the v3.1 `.dwin` terminal pattern into our React architecture — plus brand-new features v3.1 never had.

**Ported from v3.1 verbatim**:

- Mac-style traffic lights (red/yellow/green circles) on every Desktop window header, with red=kill, yellow=minimize.
- Terminal-card aesthetic: soft gradient header, centered project title, dark terminal body (`#05080d`), thin custom scrollbar, rounded corners, soft drop shadow.
- **Inline prompt bar per window**: `<input placeholder="Prompt...">` + Send + Q+ + Ctx + Mode — type directly in the window, hit Enter, NO modal round-trip. This replaces the `window.prompt()` + modal flow in Desktop mode. Q+ tags the prompt as `[queued]`, Ctx sends a context ping, Mode cycles pane mode via `/mode`.
- **Layout buttons**: Tile (sqrt(n) grid), Cascade (28px stagger), Stack (all centered), Show All (restores minimized).
- **Broadcast input** in the desktop toolbar: one-shot send to every visible Claude pane.
- **Dock bar redesigned**: 44px circular avatars with 2-letter project initials + pulsing status dot (green=idle, blue=working, yellow=permission). Glass-blur floating pill bottom-center of desktop.

**Brand-new (no v3.1 equivalent)**:

- **A2A arrows overlay**: curved SVG arrows drawn from pane-N to pane-M for every in-flight or recent A2A `corr`, derived PURELY from the SSE event stream (no backend change needed). Blue=open, green=resolved, red=orphaned. Dashed when resolved/errored, solid when in-flight. Labels show `corr·type`. Re-renders on resize + every 2s for layout drift.
- **Toasts** (top-right stack): `session_completed` (✅), `session_permission` (🔐), `peer_orphaned` (⚠️). Auto-dismiss 6s, manually closeable.
- **Sounds**: WebAudio-synthesized beeps — 880→1320Hz fanfare on completed, 660Hz on permission, 440Hz on orphaned. No audio assets shipped. Respects browser autoplay policies.

### Bundle

213.93KB JS (+10KB vs v2.0 for A2A arrows + toasts + sounds), 14.83KB CSS. Zero TypeScript errors. E2E-validated via Playwright before commit per the "no syntax-only ship" rule (claim 9393).

### Still on roadmap (v2.2+)

- Sessions sidebar view (per v3.1 screenshots: click pane → big terminal on right).
- Spawn view with project grid (per v3.1 screenshots).
- Active Tasks collapsible drawer.
- Monitoring section showing what OmniClaude is watching.
- OmniClaude pinned window (always visible).
- Replace react-rnd with custom hook.
- Cmd+K command palette.

## [2.0.0] - 2026-04-14

### Major — Dashboard v2.0 (windowing + PromptComposer + permission buttons)

User feedback on v1.1 dashboard: "altamente inferior" to the v3.1 ancestor which had drag/resize windows. This release recovers the v3.1 UX bar — **adapted to the agent-centric architecture** — plus new features v3.1 never had.

- **Desktop view** (new tab alongside Grid) — free-form windowed layout via `react-rnd`. Drag by pane header, resize via edges/corners, minimize to bottom dock, focus-to-top on click. Layout persists per-pane to `localStorage[theorchestra:desktop-layout:v2]` with schema-versioned key + parse-failure fallback.
- **DockBar** — bottom taskbar for minimized windows. Click to restore. Shows project name + status dot.
- **PromptComposer** — modal replacement for `window.prompt()`. Multiline `<textarea>`, `Ctrl+Enter` submits, `Escape` cancels, last-5 prompts history dropdown (per-user localStorage), **broadcast mode** (checkbox list when ≥2 panes selected in Grid view → sends prompt to all in parallel via `Promise.allSettled`, per-target errors don't block siblings).
- **Permission inline buttons** — when a pane enters `status: 'permission'`, its action row auto-swaps to `[✅ Approve] [✅✅ Always] [❌ Reject]`, wired to `POST /api/panes/:id/key` with `1`/`2`/`3`. Debounced 500ms per-pane against double-clicks.
- **View tabs** — `Grid` / `Desktop` / `Events` / `Tasks` at the top; active tab persists to localStorage. Events and Tasks now have full-width views in addition to the sidebar/bottom rails.
- **Selection + Broadcast** — checkbox on each Grid card, "📢 Broadcast to N" appears in header when ≥1 selected.
- **New hooks**: `useLocalStorage` (versioned keys + cross-tab sync), `useZStack` (z-index management for Desktop since react-rnd doesn't ship one).
- **Codex identity detection** — `PaneCard` now scans the output for `gpt-` prefix in addition to title, so Codex panes show `codex` badge.

### Verified E2E

All previously-committed-but-untested pattern REJECTED — per the rule in claim 9393: npm run build + Playwright smoke is now non-optional pre-push. Dashboard v2.0 was validated via claude-in-chrome Playwright MCP with every interaction tested (drag, resize, minimize, restore, select, broadcast, tab switch, localStorage persistence) before this commit. Zero console errors from our code.

### Dependencies

- Added `react-rnd@^10.4.13` (~18KB gzip). Known React 18 StrictMode `findDOMNode` warning — only emits in dev builds, not our production bundle. Replacement with custom `useDraggableResizable` hook tracked for v2.1.

### Out of scope (next releases)

- **v2.0.1**: A2A panel (`GET /api/a2a/pending` + client-side SSE accumulation showing pane-to-pane corr timeline) + maximize-to-modal with full scrollback + Tile/Cascade/Stack layout buttons.
- **v2.1**: replace react-rnd with custom hook, Cmd+K command palette, dark/light theme toggle, MemoryMaster claims feed, pane-to-pane graph view.

## [1.5.1] - 2026-04-14

### Renamed — `clawfleet` → `theorchestra`

The project rebranded from `clawfleet` to `theorchestra`. GitHub repo renamed via `gh repo rename` (old URL `wolverin0/clawfleet` redirects to `wolverin0/theorchestra` automatically). Local folder remains at `wezbridge/` for process path stability (per the original folder-rename constraint). MCP namespace remains `wezbridge` (per the same compatibility constraint — existing Claude Code sessions registered the MCP under `wezbridge` and we don't break them).

Mass replacement: 126 string refs across 33 files (all docs, code, config — `clawfleet` → `theorchestra` with capitalization preserved). PM2 app names changed (`clawfleet-streamer` → `theorchestra-streamer`, `clawfleet-dashboard` → `theorchestra-dashboard`); update your `pm2 start ecosystem.config.cjs` invocation if you'd already deployed. `theorchestra-media/` and `theorchestra-voice/` are the new tmpdir cache paths.

## [1.5.0] - 2026-04-14

### Added — big feature landing: voice + media + plugins + webhooks

- **`src/voice-handler.cjs`** — OpenAI-compatible Whisper transcription. `downloadTelegramVoice(fileId, botToken)` + `transcribe(path, {language, model, endpoint})`. Zero-dep: pure Node stdlib `https` + manual multipart builder (no `openai` SDK, no `form-data` package). Endpoint overridable for self-hosted Whisper / Groq. Env: `WHISPER_API_KEY`, `WHISPER_ENDPOINT`, `WHISPER_MODEL`, `WHISPER_LANGUAGE`.
- **`src/media-handler.cjs`** — Telegram photo/document/video/audio/voice → local paths on `os.tmpdir()/theorchestra-media/`. `downloadMessageMedia(msg, botToken)` + `formatPromptPreamble({paths, caption})`. Stable file_id-based filenames (idempotent, no re-downloads). Claude Code's `Read` tool / Codex equivalents open the files directly — no base64, no image processing, no third-party upload.
- **`src/plugin-host.cjs`** + **`plugins/`** — drop-in replacement for `node src/omni-watcher.cjs` in Monitor configs. Loads `plugins/<name>/index.cjs` (or `.cjs` files at the plugins root), dispatches watcher events to `{name, register(ctx)}` modules. Context is deliberately narrow: `wezterm` + `on/emit/log` + `readOutput` — NO bot, NO pane mutation, NO secrets. Plugins observe and emit; OmniClaude decides. Ships with `plugins/example/` (hello-world) + full API ref at `docs/plugins.md`.
- **`src/github-webhook.cjs`** — HTTP receiver for GitHub webhooks. Verifies `X-Hub-Signature-256` HMAC (timing-safe). Formats `push`, `pull_request`, `issues`, `release`, `workflow_run` events into Telegram-ready HTML chunks. Emits theorchestra events (`source: 'github'`) on stdout — same JSON-per-line pattern as the watcher. Standalone or mountable on an existing http server via `handleRequest(req, res)`.

### Documented

- `docs/features/voice-prompts.md`, `docs/features/media-forwarding.md`, `docs/features/github-webhooks.md`, `docs/plugins.md`, `plugins/README.md`, `plugins/example/README.md`.

### Architectural rigor

Every new module in this release honors the agent-centric boundary: the observation layer (watchers, plugins, receivers, helpers) cannot post to Telegram, cannot mutate panes, cannot access secrets. OmniClaude — a real Claude Code session — is the single decision point. See claim 9289 for the rule.

### Still pending

- **Inline mode** (`@theorchestra_bot`) — blocked on an upstream Telegram channel plugin patch for `callback_query` / `inline_query` forwarding. Not theorchestra-side work.

## [1.4.0] - 2026-04-14

### Added — Telegram UX helpers

- **`src/permission-alerts.cjs`** — `formatPermissionAlert({paneId, projectName, promptPreview})` renders a Telegram-ready HTML block asking the user to reply `/approve`, `/always`, or `/reject`. `parsePermissionCommand(text)` maps the reply back to a `send_key` payload (`1`, `2`, `3`). Text-command flow because the Telegram channel plugin owns `getUpdates` — inline buttons gated on an upstream plugin patch (deferred to Phase 4).
- **`src/project-scanner.cjs`** — enumerates every Claude Code project under `~/.claude/projects/` AND every Codex CLI session under `~/.codex/sessions/`. Resolves the real cwd by reading the newest JSONL's `cwd` field (30 KB tail read, safe on multi-GB logs). Returns `{ agent: 'claude'|'codex', realPath, name, sessionCount, latestSessionUuid, latestActivityMs }`. CLI mode: `node src/project-scanner.cjs [--json] [--no-codex] [--limit N]`.

### Documented

- `docs/features/permission-commands.md` — end-to-end flow, OmniClaude Event Reaction Tree entry, security note (anyone in the Telegram group can approve).
- `docs/features/project-scanner.md` — OmniClaude `/projects` and `/spawn <name>` command handlers, performance notes.

### Cross-LLM

Project scanner is the first theorchestra module to deliberately index BOTH Claude and Codex sessions — previously every cross-LLM affordance was runtime (spawning Codex panes from Claude). With this, `/projects` can spawn either agent for any project by friendly name.

## [1.3.0] - 2026-04-14

### Added — ops & observability

- **`src/diff-reporter.cjs`** — compact post-session-completed git-stat summary. Returns `{ summary, files, top, html, plain, branch, clean }` or `null` when there are no tracked changes. Designed for OmniClaude to post "what just changed?" to the pane's Telegram topic after a `session_completed` event. CLI mode: `node src/diff-reporter.cjs [cwd] [--json]`. Read-only.
- **`src/ntfy-notifier.cjs`** — [ntfy.sh](https://ntfy.sh) backup push notification channel. `isEnabled()` returns false when `NTFY_TOPIC` is unset so callers can always-call. Supports public ntfy.sh + self-hosted + token-authenticated instances. 80 LOC, Node stdlib only.
- **`ecosystem.config.cjs`** — PM2 production supervisor config. Two apps: `theorchestra-streamer` (telegram-streamer.cjs) + `theorchestra-dashboard` (dashboard-server.cjs). Watcher stays under OmniClaude's Monitor tool by default (commented config template included).

### Documented

- `docs/features/diff-reporter.md` — OmniClaude Event Reaction Tree integration + rate-limit/filter heuristics (skip trivial edits).
- `docs/features/ntfy-and-pm2.md` — ntfy setup (public / self-hosted / authenticated), PM2 commands, rationale for keeping OmniClaude itself outside PM2.

### Env vars

- `NTFY_TOPIC` (enables ntfy), `NTFY_SERVER` (default `https://ntfy.sh`), `NTFY_TOKEN` (optional bearer).

## [1.2.0] - 2026-04-14

### Added — new wezbridge MCP tools (6)

- **`split_pane(pane_id, direction?, cwd?, program?, args?)`** — side-by-side or top/bottom split without auto-launching Claude. Opens a shell / Codex / any program next to an existing session.
- **`set_tab_title(pane_id, title)`** — live rename a WezTerm tab. Best practice for multi-pane projects: `<project>-<agent>` (e.g. `app-codex`, `app-claude`).
- **`spawn_ssh_domain(domain, cwd?, program?, args?)`** — spawn a pane on a pre-configured WezTerm SSH domain. Run remote Claude/Codex sessions that local OmniClaude can still `send_prompt` / `read_output` / `kill_session` through.
- **`list_workspaces`** — enumerate WezTerm workspaces and the panes in each.
- **`switch_workspace(name)`** — activate a workspace (creates if missing).
- **`spawn_in_workspace(workspace, cwd?, program?, args?)`** — create a new pane directly in a named workspace. Useful for grouping peer panes by project.

### Documented

- `docs/features/split-workspace-remote.md` — `/split`, `/rename`, `/remote` Telegram command handlers for OmniClaude, plus recommended worktree flow for multi-pane peer projects on shared repos.
- `docs/features/workspaces.md` — `/workspace` command, WezTerm version compatibility caveats, when-to-use `workspaces` vs `split_pane`.

### Compatibility

- Running Claude Code sessions must reload the `wezbridge` MCP server to see the new tools.
- Some older WezTerm versions may not support all workspace operations — `list_workspaces` is widely supported, `switch_workspace` / `spawn_in_workspace` need recent WezTerm.

## [1.1.0] - 2026-04-14

### Added

- **Desktop dashboard** (Vite + React + TypeScript strict) — pane grid view, live SSE event stream from `omni-watcher.cjs`, active_tasks panel, action buttons (Prompt / Enter / Y / Kill).
- **`src/dashboard-server.cjs`** — ~200 LOC Node-stdlib HTTP + SSE backend. Endpoints: `GET /api/panes`, `GET /api/panes/:id/output`, `GET /api/tasks`, `GET /api/events` (SSE), `POST /api/panes/:id/prompt|key|kill`, `POST /api/spawn`. Also serves the built SPA from `dashboard/dist/`.
- **`dashboard/`** — Vite + React app. Dev: `npm run dev` proxies `/api` to `:4200`. Prod: `npm run build` emits `dashboard/dist/` which the backend serves directly.
- Dark terminal-native theme, snake_case pane shape matching wezbridge MCP contract.

### Not yet in this release
- A2A pending-corr panel (needs watcher-side state export)
- Claims feed (MemoryMaster MCP integration)
- Permission-prompt inline approve/reject buttons (upstream plugin patch required)
- Auth (assumes localhost-only)

## [1.0.0] - 2026-04-14

Initial public release as `theorchestra`. Forked in spirit (not in history) from [wolverin0/wezbridge v3.1](https://github.com/wolverin0/wezbridge) — substrate shared, coordination philosophy replaced.

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

The MCP namespace is **`wezbridge`** (not `theorchestra`) to match the tool name agents call (`mcp__wezbridge__*`). The project is called theorchestra; the MCP tool stays `wezbridge` for backward compatibility with any existing Claude Code sessions that already have it registered.

---

## Pre-v1.0

Pre-rebrand iteration happened in `wolverin0/wezbridge` (v1–v3.1). That repo remains as the historical artifact of the bot-centric architecture and is not part of this changelog.
