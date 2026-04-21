# Dashboard v2.3 — Compact awareness + A2A focus + Handoff push

**Status**: planning · 2026-04-14
**Tracks**: theorchestra/wezbridge dashboard (HTML v3.1 served from `src/dashboard.html` on :4200)
**Supersedes**: `docs/PLAN-dashboard-v2.md` (v2.0/v2.1 — React-based, abandoned in pivot to v3.1 HTML)

## Why

v3.1 HTML port restored the visual fidelity the user wanted but dropped two things we had in v2.1:

1. **A2A visibility** — no arrows, no orphan alerts, no pending-corr panel
2. **Active Tasks** — not rendered anywhere in the current dashboard

Also the legacy Live Feed ate ~1/3 of screen. We need the awareness signals without the screen tax.

New user brainstorm (2026-04-14): **A2A handoff push button** — one-click context transfer from one pane to another, persisted as an immutable `.md` file in the target project's folder so the full handoff history is auditable.

## Goals (ordered by user priority)

1. Compact right sidebar: OmniClaude monitor tile + A2A activity + Events feed, all collapsible, none eating more than 260px
2. Bottom compact Active Tasks strip (collapsible to 32px badge)
3. A2A focus: badges on pane cards, visual corrs, orphan alerts with push-to-panel
4. **A2A handoff push** — click `↗ Handoff to…` on a pane card, pick target, generate unique handoff file + inject prompt into target pane
5. Claude Routines integration (optional) — OmniClaude escalations can `POST /fire` to cloud routines for nightly investigations

## Non-goals (explicit)

- Mobile responsive (desktop-only, per user)
- Replace WezTerm or local panes
- Token/cost tracking UI
- Authentication (localhost-only)
- Migrate back to React (HTML v3.1 stays)

---

## Phase 1 — Compact right sidebar

Replace the current Live Feed full-column rail with a 260px collapsible sidebar containing 3 stacked panels.

### Panel A — OmniClaude monitor (always visible when sidebar open)

- Header: `◎ OmniClaude · pane-21 · status-dot`
- Body: scrollable, last 15 non-empty lines from OmniClaude pane via `/api/panes/21/output?lines=40`
- Auto-refresh every 3s while sidebar is open
- OmniClaude pane-id resolved from project name match (same heuristic as old dashboard.cjs `autoDetectOmni`)
- Click header → scrolls Desktop view to that pane card

### Panel B — A2A activity

- Source: SSE `peer_orphaned` events + `/api/a2a/pending` snapshot on mount (NEW endpoint — see Phase 3)
- Entries: `pane-N ↔ pane-M · corr=XYZ · 2m 10s · resolved | orphaned` (color-coded)
- LRU cap 50 + 24h TTL eviction to bound memory
- Orphaned rows: red border + pulse
- Click a row → highlights both panes on Desktop view + scrolls to first

### Panel C — Events (compact)

- Replaces current verbose Live Feed
- One-liner per event: `HH:MM:SS · badge · project · event-type` (NO verbatim output in the rail)
- Click entry → expands to show `ev.output` inline (accordion)
- Cap at 100 entries, newest first
- Filter chips: All | Completed | Permission | Started | Orphaned

### Sidebar controls

- Single arrow at far right of topbar toggles whole sidebar (260px ↔ 32px rail)
- Within sidebar: each panel has its own chevron to collapse to header only
- Order is user-reorderable: drag panel headers; persisted to `localStorage['theorchestra:sidebar-panel-order:v1']`
- Collapse states persisted per-panel in `localStorage['theorchestra:sidebar-panel-collapsed:v1']`

### Acceptance

- Screenshot all 4 tab views (Sessions, Live, Desktop, Spawn) showing sidebar collapsed (32px) AND expanded (260px). No view should render the sidebar eating more than 260px.
- Drag paneles B before A → reload → order persists.
- Curl `/api/a2a/pending` returns `{corrs: [...]}` snapshot.

---

## Phase 2 — Active Tasks bottom strip

- Bottom of dashboard: 32px collapsed / 180px expanded horizontal strip
- Collapsed state: a single badge `● Active tasks · 7 pending · 3 in progress`
- Expanded state: horizontally scrolleable row of pill cards `[T-007] pane-20 · pending | pane-20 Error Learning Loop...`
- Status color: `pending=warn`, `in_progress=accent`, `completed=green` (dim opacity 0.5), `cancelled=red strikethrough`
- Click pill → modal with full task body + linked pane
- Collapse state: `localStorage['theorchestra:tasks-strip-collapsed:v1']`

### Acceptance

- Strip visible on all 4 views
- Collapse/expand arrow toggles between 32px and 180px
- Click pill → modal shows task details

---

## Phase 3 — A2A focus features

### 3.1 New backend endpoint `/api/a2a/pending`

- In `src/dashboard-server.cjs`, maintain an in-process A2A state replica by subscribing to its own spawned omni-watcher child (same pattern as existing SSE fan-out).
- Parse any event line with `corr=...` in its summary; track `{corr, from, to, firstSeen, lastSeen, status}`.
- Status transitions: `request → active → resolved | orphaned`.
- LRU cap at 500 corrs, 24h TTL eviction.
- `GET /api/a2a/pending` returns `{corrs: [{corr, from, to, firstSeen, lastSeen, status}]}`.

### 3.2 Pane card A2A badges

- On each pane card in Sessions list sidebar AND Desktop view, render small badge in the card header when that pane participates in an active (non-resolved) corr:
  - `↗ pane-8` (outgoing) or `↙ pane-10` (incoming) — color-coded by corr status
- Click badge → scrolls/highlights the peer pane
- If `peer_orphaned` fires for that corr → badge turns red with pulse, also pushes toast

### 3.3 Orphan alerts

- Existing Toasts.tsx v2.1 code ported inline into dashboard.html as ~40-line vanilla JS:
  - Subscribe to SSE, filter `type === 'permission'` where `raw.event === 'peer_orphaned'`
  - Slide-in toast top-right: `⚠️ pane-6 orphaned peer · corr=T-021`
  - 6s auto-dismiss, click → jumps to A2A panel with that corr scrolled into view

### Acceptance

- Trigger an A2A exchange between 2 real panes → badges appear on both cards
- Kill the responder → `peer_orphaned` → red badge on surviving pane + toast + A2A panel row turns red
- Refresh page → HTTP snapshot via `/api/a2a/pending` restores all active corrs (no loss on reload)

---

## Phase 4 — A2A handoff push (REDESIGNED v2.3.1 per user feedback 2026-04-14)

### Design note (v2.3 → v2.3.1)

v2.3 original: backend wrote handoff file to target's cwd + injected envelope directly into target pane.

**v2.3.1 actual (shipped)**: backend sends an INSTRUCTIVE PROMPT to the SOURCE pane. The source pane then (a) authors the handoff file in its OWN `handoffs/` folder, (b) contacts the target via wezbridge MCP `send_prompt` + `send_key('enter')`. This gives the source Claude authorial control over its own handoff (richest context) and makes every handoff a clean A2A envelope originating from the source's own MCP calls.

## Phase 4 — A2A handoff push (NEW, user brainstorm 2026-04-14)

One-click context transfer from pane to pane, persisted immutably per-project.

### 4.1 UI flow

- Each pane card in Sessions list + Desktop view gets a new button: `↗ Handoff`
- Click → dropdown of all OTHER claude/codex panes: `paperclip (pane-5)`, `wezbridge (pane-10)`, …
- Pick target → modal opens with 2 fields:
  1. **Summary** (prefilled auto-generated draft: last 30 lines of source pane stripped of ANSI, ~200 words max)
  2. **Instruction for target** — free-text, placeholder shows 3 templates:
     - `"Continue this work. Full handoff in {file}."`
     - `"Review what I did and send your comments when done."`
     - `"Take over — I'm hitting rate limits."`
- Submit → 2 actions fire atomically:
  1. **Write handoff file** (see 4.2)
  2. **Inject A2A prompt** into target pane (see 4.3)

### 4.2 Handoff file contract

- Written to `<target-project-cwd>/handoffs/handoff-from-<source-name>-<ISO-timestamp>-<short-uuid>.md`
  - Example: `G:/_OneDrive/.../paperclip/handoffs/handoff-from-memorymaster-2026-04-14T17-46-12-a1b2c3.md`
  - Directory created if missing (`fs.mkdirSync recursive: true`)
- **NEVER overwrites existing files** (each handoff is a new file, full history preserved)
- File body:
  ```
  # Handoff from memorymaster (pane-2) → paperclip (pane-5)

  **Sent**: 2026-04-14T17:46:12Z
  **Corr**: handoff-a1b2c3
  **Source project**: G:/.../memorymaster

  ## Summary
  {user-edited or auto-generated summary}

  ## Instruction
  {user free-text}

  ## Source scrollback (last 30 lines)
  ```
  {ANSI-stripped scrollback}
  ```
  ```

### 4.3 Injected prompt shape (into target pane)

Standard A2A envelope + handoff pointer:

```
[A2A from pane-2 to pane-5 | corr=handoff-a1b2c3 | type=request]
Handoff received. File: handoffs/handoff-from-memorymaster-2026-04-14T17-46-12-a1b2c3.md

{instruction text}

Read the handoff file first, then acknowledge with an ack envelope and proceed.
```

Delivered via `wez.sendText(targetPaneId, msg)` + `wez.sendTextNoEnter(targetPaneId, '\r')` (the A2A hard-rule enter sequence, claim 8945).

### 4.4 Backend endpoint

- `POST /api/a2a/handoff` body: `{source_pane, target_pane, summary, instruction}`
- Server:
  1. Resolves source+target cwd via `discoverPanes()`
  2. Generates `corr = 'handoff-' + 6-char base36 random`
  3. Generates ISO timestamp safe for filename (`:` → `-`)
  4. Fetches source scrollback via `wez.getFullText(source_pane, 30)`
  5. Writes handoff file to target cwd
  6. Injects envelope into target pane
  7. Emits synthetic SSE event: `{type:'a2a_handoff', corr, source_pane, target_pane, file, timestamp}` (added to NOISE allowlist)
- Returns `{ok, corr, file, target_pane}`

### 4.5 Handoff history view

- Click `↗ Handoff` button with NO target selected → opens a modal "Recent handoffs for this pane"
- Shows last 20 handoffs where this pane is source OR target
- Each row: `→ paperclip · 2m ago · "Continue the work..."` (clickable → opens the file)
- Data source: SSE `a2a_handoff` events (in-memory) + on-demand filesystem scan of `<cwd>/handoffs/*.md` for cold-start

### Acceptance

- Click `↗ Handoff` on memorymaster → pick paperclip → type "continue the deduplication work" → Submit
- Verify file created at `paperclip/handoffs/handoff-from-memorymaster-<ts>-<uuid>.md`
- Verify paperclip pane receives the envelope + Enter
- Click `↗ Handoff` again on memorymaster → pick paperclip → type different text → Submit
- Verify SECOND file created, first still exists, full history in folder
- Reload page → history modal populates from filesystem scan

---

## Phase 5 — Claude Routines integration (optional, user-gated)

Research preview feature: Anthropic-hosted scheduled/API/GitHub-triggered autonomous Claude Code sessions. Min schedule 1h, API `POST /v1/claude_code/routines/:id/fire` with bearer token, output = PRs on `claude/*` branches in selected repos.

### Where it fits our workflow

- **NOT** a replacement for OmniClaude (Routines can't touch WezTerm panes, min 1h too slow for proactive tick)
- **IS** useful for async heavy-lifting the orchestrator delegates overnight

### Proposed pilot routines (user approves before creating)

1. **Orphan investigator** (API trigger)
   - Fires when OmniClaude daemon detects `peer_orphaned` + escalation age > 30min
   - Receives `corr` + scrollback as `text` POST body
   - Opens PR with diagnosis comment in relevant repo
2. **Nightly wiki drift** (schedule, weekly)
   - Compares MemoryMaster claims against wiki articles
   - Opens PR on `obsidian-vault` with suggested updates
3. **PR review guardrail** (GitHub trigger on `pull_request.opened`)
   - Runs on theorchestra + wezbridge + omniclaude repos
   - Applies custom review checklist + leaves inline comments

### Integration points

- `vault/_routines-config.md` (new): table of registered routine IDs + tokens + triggers + notes
- `src/orchestrator-executor.cjs`: new action type `fire_routine` with routine_id + payload
- New hybrid classifier rule: `fire_routine` always escalates (never auto-fires) in v1

### Acceptance

- User manually creates the 3 routines at claude.ai/code/routines
- Pastes URLs + tokens into `vault/_routines-config.md`
- Orchestrator daemon reads config on boot, supports `fire_routine` actions
- Fire one manually via dashboard button "Investigate with routine" → verify session appears in claude.ai/code

---

## Verification strategy

Per feedback claim 9427 (this session): screenshot EVERY view after every phase, not just the pretty one.

Per-phase acceptance:
1. Phase 1: 4 screenshots (each tab) × 2 sidebar states (open/closed) = 8
2. Phase 2: 4 screenshots (each tab) × 2 strip states = 8
3. Phase 3: trigger real A2A, orphan one side, screenshot before/after
4. Phase 4: end-to-end handoff test with filesystem verification
5. Phase 5: manual user loop (Routines need their click-through)

## Risks

| Risk | Mitigation |
|---|---|
| SSE event floods on many panes | LRU cap on client + server, debounce at 200ms |
| Handoff file directory doesn't exist in target cwd | `mkdirSync recursive: true` on write |
| Handoff fires to dead pane | Validate pane_id is alive before write + inject |
| Routines token leaked | Store tokens in `.env.routines` (gitignored), not in vault/ |
| LocalStorage schema drift | Versioned keys `:v1`, parse-fail fallback to defaults |
| OmniClaude pane-id changes across reboots | Resolve by project name match on every load, cache 30s |

## Out of scope / deferred

- Handoff via network/cloud (only local filesystem for now)
- Multi-pane handoff (1→N) — only 1→1 in v2.3
- Handoff templates editor UI (hardcoded 3 templates in v2.3)
- Replace the Live Feed entirely (keep compact Events panel C; don't remove it)
- Routines extra usage / billing management (out of scope, manual at claude.ai)
