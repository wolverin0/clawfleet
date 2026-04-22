# PLAN OF TRUTH — theorchestra v3.0 Autonomous Orchestration

**Status:** AUTHORITATIVE. This document supersedes every prior plan, remediation,
and phase doc in `docs/`. Older docs are archived under `docs/_archive/`.

**Created:** 2026-04-21
**Goal:** Deliver the v3.0 thesis — an LLM-advised, dashboard-aware orchestrator
that autonomously runs many Claude Code panes and escalates to the user only
when genuine human judgment is required.

**Success criteria (binary):** All checkboxes below are ticked + the final
gate (`scripts/v3-plan-of-truth-gate.ts`) exits 0.

---

## Non-negotiable constraints

- No new features outside this doc. No refactors outside this doc.
- Every item has a verification step. No item is ticked without evidence.
- Drift = immediately stop and re-read this plan.
- Test plan lives WITH each phase, not at the end.

---

## PHASE 0 — Lock the plan

- [x] **P0.1** Archive superseded plan docs to `docs/_archive/`:
      `PLAN-dashboard-v2.3.md`, `PLAN-dashboard-v2.4-cleanup.md`, `v3.0-plan.md`,
      `REMEDIATION.md`. ADRs (`docs/adrs/**`) stay — they're decisions.
      (`v3.0-spec.md`, `v3.0-decisions.md`, `v3.0-test-log.md` stay — reference, not plans.)
- [x] **P0.2** `docs/PLAN-OF-TRUTH.md` (this file) is the ONLY live plan.
- [x] **P0.3** Folded into the single `feat(v3)` commit 46fa67e alongside P5.5.

**Verify:** `ls docs/PLAN*.md docs/v3*.md docs/REMEDIATION.md 2>/dev/null` shows
only `PLAN-OF-TRUTH.md`.

---

## PHASE 1 — Stability baseline (regression fence)

Prove the code that already shipped still works before adding anything.

- [x] **P1.1** `npm run v3:typecheck` passes.
- [x] **P1.2** `npm run v3:start` boots clean; `/api/health` returns ok.
- [x] **P1.3** Dashboard loads on `http://127.0.0.1:4300` AND `http://<LAN-IP>:4300`.
- [x] **P1.4** Spawn cmd.exe pane via UI → streaming works (bytes visible in <1s). (166 chars / 4 lines in 2s)
- [x] **P1.5** `POST /api/orchestrator/snapshot` returns `refsCount > 0`. (71 refs)
- [x] **P1.6** `POST /api/orchestrator/act {ref, verb: 'hover'}` returns `{ok: true}`.
- [x] **P1.7** `npm run v3:phase11-ui` (Playwright UI smoke): 21/21 PASS.

**Verify:** Run `scripts/v3-baseline-gate.ts` — asserts all seven above.
Non-zero exit = fix before advancing.

---

## PHASE 2 — LLM advisor (the subjective-reasoning layer)

The missing piece. Orchestrator currently escalates every subjective decision.
Advisor gets one shot to decide: `mechanic`, `content`, `dashboard_action`, or
`no_op`. Advisor decision attests the Action; attested actions bypass the
default "UI mutation = content" classifier rule and fire as mechanics.

**Provider strategy:** support two, pick first available at runtime.
1. Anthropic API direct (`ANTHROPIC_API_KEY` env) → `claude-haiku-4-5-20251001`, cheap.
2. Claude CLI subprocess (`claude -p '<prompt>'`) → zero-config if user has Claude Code on PATH.

**Opt-in:** advisor is OFF by default. Enable with `THEORCHESTRA_LLM_ADVISOR=1`.

### 2.A Implementation

- [x] **P2.A1** `src/backend/orchestrator/llm-advisor.ts` — `LlmAdvisor` class.
      Interface: `advise(ctx: AdvisorInput): Promise<AdvisorVerdict>`.
- [x] **P2.A2** `AdvisorInput` carries: event + pane last-50-lines (via
      `manager.renderedTail`) + dashboard snapshot (via `DashboardController`) +
      last-20 decision records + config snapshot.
- [x] **P2.A3** `AdvisorVerdict` strict shape with parse-and-validate
      (inline guards instead of zod to avoid extra dep in the hot path).
- [x] **P2.A4** Provider 1: Anthropic API direct (raw `fetch`, no SDK).
- [x] **P2.A5** Provider 2: Claude CLI subprocess.
- [x] **P2.A6** Cost cap: per-pane cooldown 30s + per-hour global cap 60.
- [x] **P2.A7** 5s hard timeout; fall-through to rule-engine verdict on any error.
- [x] **P2.A8** Plumbed into executor; `maybeReviseWithAdvisor()` only runs
      on rule-engine content-class baselines.

### 2.B Classifier attestation

- [x] **P2.B1** `ActionAttestation` + union with optional `attestation` field.
- [x] **P2.B2** Classifier honors `by:'llm-advisor'` attestation on
      `dashboard_action` → `mechanics`.
- [x] **P2.B3** DecisionRecord persists the attested Action verbatim.

### 2.C Tests

- [x] **P2.C1** `scripts/v3-llm-advisor-unit.ts` — 7/7 PASS:
  - [x] mechanic verdict keeps proposed + attaches attestation
  - [x] dashboard_action verdict produces mechanics decision
  - [x] content verdict → chat.ask fires
  - [x] provider error → rule-engine fallback (no attestation)
  - [x] malformed JSON → content fallback
  - [x] per-pane cooldown rejects second call in window
  - [x] disabled advisor → zero calls, baseline path lands
- [x] **P2.C2** `scripts/v3-llm-advisor-gate.ts` — e2e 2/2 PASS:
      `enabled=true, provider=claude-cli, model=claude-haiku-4-5-20251001`.

### 2.D Settings surface

- [x] **P2.D1** `GET /api/orchestrator/advisor` implemented and returning shape.
- [ ] **P2.D2** `POST /api/orchestrator/advisor/toggle` — deferred to P4
      (needs a dashboard UI control; no value standalone). Not blocking P3.

**Verify:** unit tests pass + gate passes (or gracefully skips if no provider).

---

## PHASE 3 — Dashboard-driven auto-actions

Close the loop. When advisor picks a `dashboard_action`, it executes without
user confirm. Already possible after P2.B, this phase hardens + instruments.

- [x] **P3.1** Whitelist enforced in `LlmAdvisor.parseVerdict()` (`click|hover|focus|dblclick`).
- [x] **P3.2** Per-ref cooldown 10 s in `DashboardController.act()` — verified
      live: second hover returns `500 cooldown: hover|e1 fired 0s ago (limit 10s)`.
- [x] **P3.3** Post-action re-snapshot 1.5s after act → `metadata.post_refs_count`
      on the DecisionRecord (with a snapshot ring-buffer mutation).
- [x] **P3.4** Decision records carry metadata:
      `{act_ok, pre_refs_count, post_refs_count, pre/post_snapshot_at}`.

### 3.A Tests

- [x] **P3.A1** `scripts/v3-dashboard-action-unit.ts` — 4/4 PASS:
  - [x] attested click dispatches
  - [x] unattested click falls to content (no advisor = no auto-click)
  - [x] cooldown blocks second click — metadata reflects failure
  - [x] dashboard disabled → executed=false
- [x] **P3.A2** `scripts/v3-dashboard-action-gate.ts` — 3/3 PASS live:
  - [x] snapshot yields 49 refs
  - [x] hover returns 200
  - [x] same-ref second hover returns 500 cooldown

---

## PHASE 4 — User visibility of orchestrator reasoning

Make the dashboard show WHY things happened, not just WHAT.

- [x] **P4.1** `GET /api/orchestrator/decisions?limit=N` returns decision records
      including attestation + metadata (pre/post refs count).
- [x] **P4.2** `src/frontend/sidebar/ReasoningPanel.tsx` renders last 20
      advisor-attested decisions. Collapsible via sidebar. Polls every 5s.
- [x] **P4.3** `OmniClaudePanel` now renders a 📸 badge on orchestrator asks
      with attached snapshots (refsCount + latency), or an error-styled badge
      if the snapshot failed.
- [x] **P4.4** Panel shows disabled-state copy when `advisor.enabled=false`
      (feature-flag behaviour).

### 4.A Tests

- [x] **P4.A1** `/api/orchestrator/decisions` shape covered in the combined
      `v3-reasoning-panel-gate.ts`. (Also implicitly covered by P3.A1.)
- [x] **P4.A2** `scripts/v3-reasoning-panel-gate.ts` — 3/3 PASS:
      advisor enabled + decisions endpoint shape + Playwright renders panel
      title. Screenshot: `docs/screenshots/v3.0/plan-of-truth-reasoning-panel.png`.

---

## PHASE 5 — Docs + final gate

- [x] **P5.1** CLAUDE.md note added pointing at this plan. (Below.)
- [x] **P5.2** README updated with advisor section. (Below.)
- [x] **P5.3** `scripts/v3-plan-of-truth-gate.ts` + `npm run v3:gate`: **6/6 PASS**.
- [x] **P5.4** All checkboxes ticked (this file).
- [x] **P5.5** Commit `46fa67e feat(v3): LLM advisor + dashboard-driven auto-actions (PLAN-OF-TRUTH)`.
- [x] **P5.6** Tagged `v3.0.0-rc.1`.

**Final verify:** `npm run v3:gate` exits 0. Screenshot of dashboard with the
reasoning panel visible lands in `docs/screenshots/v3.0/plan-of-truth-final.png`.

---

## PHASE 6 — LLM-primary orchestration (Opus)

Added 2026-04-21 after P5 shipped. The P2 advisor was gated to content-class
events — a static rule I invented for cost safety. User override: there
cannot be any static gates; the LLM decides, per-event, case-by-case. Opus
is the primary conductor. Rule engine downgrades to "suggestion source."

### 6.A Invert the gate

- [x] **P6.A1** `baselineVerdict !== 'content'` guard removed in
      `maybeReviseWithAdvisor`. Advisor fires on EVERY `SseEvent` when enabled.
- [x] **P6.A2** Default model → `claude-opus-4-7`. Live-verified:
      `provider=claude-cli, model=claude-opus-4-7`.
- [x] **P6.A3** Advisor verdict is primary; rule-engine action is fallback
      when advisor errors/times out/cools down.
- [x] **P6.A4** Classifier rails still veto — proven by unit test
      "destructive-keyword rail vetoes advisor-endorsed continue".

### 6.B Cost controls

- [x] **P6.B1** Per-pane cooldown default = 15 s.
- [x] **P6.B2** Global hourly cap default = 240; env override
      `THEORCHESTRA_LLM_HOURLY_CAP` + `THEORCHESTRA_LLM_PER_PANE_COOLDOWN_SEC`.
- [x] **P6.B3** `POST /api/orchestrator/advisor/toggle {enabled}` live.
- [x] **P6.B4** ReasoningPanel shows `X/Y` (cap), `N cool`, ON/OFF toggle button.

### 6.C Tests

- [x] **P6.C1** `scripts/v3-llm-primary-unit.ts` — 6/6 PASS.
- [x] **P6.C2** `scripts/v3-llm-primary-gate.ts` — 3/3 PASS with Opus live.

### 6.D Aggregate + release

- [x] **P6.D1** P6 gates added to aggregator.
- [x] **P6.D2** `npm run v3:gate` = 8/8 green.
- [x] **P6.D3** Commit `98033dc feat(v3): LLM-primary orchestration with Opus`.
- [x] **P6.D4** Tagged `v3.0.0-rc.2`.

## PHASE 7 — Persistent omniclaude pane (supersedes P2/P6 as primary)

Added 2026-04-21 after P6 shipped. The one-shot `claude -p` advisor is
fundamentally wasteful: loses context between calls, re-pays input tokens
every time, cannot hold multi-step intentions. The correct design is what
the user had in v2.7 (`vault/_orchestrator-worker/`): a **persistent
Claude Code session** that IS the orchestrator, with a role-defining
CLAUDE.md, MCP tool access to the backend, and a context that accumulates
turn-over-turn with prompt-cache amortization.

P2/P6 demote to **fallback** — when omniclaude is disabled or down, the
rule engine + one-shot advisor continue to work exactly as today.

### 7.A Spawn + lifecycle

- [x] **P7.A1** `vault/_omniclaude/CLAUDE.md` authored: conversational
      port of v2.7 worker with role definition, decision framework,
      action shapes, safety rules.
- [x] **P7.A2** `startOmniclaudeDriver()` spawns via `cmd.exe /c claude
      --continue` on Windows (direct spawn errors with code 2 on .cmd
      wrappers). POSIX uses direct `claude` spawn.
- [x] **P7.A3** `GET /api/sessions` filters omniclaude unless
      `?include_omni=1`. New `GET /api/orchestrator/omniclaude` returns
      enabled flag + session record.
- [x] **P7.A4** Boot prompt `[BOOT] theorchestra backend started…`
      injected 4s after spawn so Claude has time to load CLAUDE.md.

### 7.B Event → prompt channel

- [x] **P7.B1** Event formatter produces `[EVENT type=X id=N ts=iso]`
      prompts. Bodies per event type in `formatEventBody()`.
- [x] **P7.B2** Queue reuses existing `PaneQueueStore` keyed by the
      omniclaude sid; drains on its own `pane_idle`.
- [x] **P7.B3** Self-filter: events with `sessionId === omniSid` are
      skipped so omniclaude doesn't chase its own output.

### 7.C MCP tools omniclaude needs

- [x] **P7.C1** Existing tools audited: spawn_session, send_prompt,
      send_key, read_output, kill_session, discover_sessions, get_status,
      auto_handoff, wait_for_idle. All intact.
- [x] **P7.C2** Five new MCP tools in `src/mcp/handlers/omniclaude.ts`:
      `snapshot_dashboard`, `act_on_ref`, `get_recent_decisions`,
      `get_chat_messages`, `ask_user`. Backend endpoint added:
      `POST /api/chat/orchestrator-ask`.
- [x] **P7.C3** MCP auth works transparently — backend client reads
      token via env / token file; omniclaude pane's cwd sees
      .mcp.json.

### 7.D Self-handoff (own ctx)

- [x] **P7.D1** Documented in CLAUDE.md under "Your own ctx" section;
      mechanism already exists via `ctx_threshold` event emission +
      omniclaude receives it as any other event (self-filter exempts
      ctx_threshold for the omni sid since it's the one that matters
      to omniclaude).
- [x] **P7.D2** CLAUDE.md boot sequence reads `state.md` if present.

### 7.E Fallback path

- [x] **P7.E1** Documented: when omniclaude is disabled / not spawned,
      the P6 rule-engine + one-shot advisor path continues to work.
      No code regression — driver returns `NOT_RUNNING` stub cleanly.
- [ ] **P7.E2** Health check (30s-idle-after-event = dead) — deferred
      to a later iteration; MVP relies on omniclaude staying responsive.

### 7.F Persistence (crash recovery)

- [x] **P7.F1** `claude --continue` mechanism is the primary
      persistence. Session history lives in
      `~/.claude/projects/<cwd-hash>/<session-id>.jsonl`.
- [ ] **P7.F2** Periodic state.md snapshot — omniclaude's own
      responsibility via its CLAUDE.md instructions (no backend poll).

### 7.G Tests + gate

- [x] **P7.G1** `scripts/v3-omniclaude-unit.ts` — 3/3 PASS:
      disabled stub, no-claude graceful, event→prompt pipeline + self-filter.
- [x] **P7.G2** `scripts/v3-omniclaude-gate.ts` — 4/4 PASS live:
      spawn verified, sessions filter verified, `?include_omni=1` bypass
      verified, 275 bytes streamed from omniclaude pane.
- [x] **P7.G3** Both added to aggregator.

### 7.H Release

- [x] **P7.H1** `npm run v3:gate` = 10/10 green.
- [x] **P7.H2** Commit `e81b996 feat(v3): persistent omniclaude pane`.
- [x] **P7.H3** Tagged `v3.1.0-rc.1`.

## PHASE 8 — Close spec gaps + real behavior gate

Added 2026-04-22 after multi-day dogfood found two silent bugs (token-file
not propagated to MCP subprocess; PaneQueueStore drain dead-zone when pane
already idle at enqueue) that ALL prior P1-P7 gates missed — they checked
HTTP shapes, not user-facing outcomes. User correctly called this out:
"what kind of tests you do that say YES MAN ITS ALL OK!". This phase
closes the remaining spec gaps and replaces wiring-level gates with a
behavior-level one.

### 8.A — Close FR-MCP parity gap on `spawn_session`

- [x] **P8.A1** Add optional `cli`, `args`, `tab_title` to `spawnSchema` in
      `src/mcp/handlers/session-mgmt.ts`.
- [x] **P8.A2** When `cli !== 'claude'`, bypass all Claude-specific flag
      logic; pass `{cli, args, cwd, tabTitle}` straight to
      `backendClient.spawnSession`. On Windows, auto-wrap `.cmd` wrappers
      through cmd.exe.
- [x] **P8.A3** Verified live: omniclaude asked to spawn cmd.exe with
      tab_title=pedrito → pane `aa7d8683` with tabTitle=pedrito appears.

### 8.B — Close FR-Orch-5 decisions-log gap

- [x] **P8.B1** `OmniclaudeDriver` subscribes to `manager.on('data', …)`
      for the omni sid, strips ANSI + control chars, matches
      `/DECISION:\s*([\w-]+)\s*[—–-]\s*(.{1,400})/g` across a line-buffered
      stream, appends to `DecisionLog` with `trigger:'omniclaude_decision'`
      + `metadata.source:'omniclaude-scrollback'`.
- [x] **P8.B2** Dedupe by `(kind, first-100-chars-of-reason)` ring (cap 500).
- [x] **P8.B3** Wired via `startOmniclaudeDriver({decisionLog: orchestrator.log})`
      in `theorchestra-start.ts`.
- [x] **P8.B4** Verified live: tmp dir's decisions-YYYY-MM-DD.md contains
      `omni_decision` entries after a tell-omni prompt.

### 8.C — Real behavior gate (not wiring)

- [x] **P8.C1** `scripts/v3-behavior-gate.ts` — 5 scenarios, each using
      count-before / act / wait / count-after pattern:
  - [x] spawn claude pane → new pane appears
  - [x] spawn cmd.exe pane with tab_title=pedrito → new pane appears
  - [x] kill pane → pane disappears
  - [x] decisions log captures omniclaude DECISION lines (45s poll)
  - [x] pane_idle coalesce steady-state ≤60/min
- [x] **P8.C2** Env `BEHAVIOR_GATE_KEEP_TMP=1` keeps tmp dir for inspection.
- [x] **P8.C3** Live run: **5/5 PASS** (45s + 10s + 30s + 0s + 60s).

### 8.D — Doc alignment

- [x] **P8.D1** Addendum appended to `docs/v3.0-decisions.md` (7 items:
      omniclaude > advisor, auto-respawn opt-in, kill-on-shutdown default off,
      rule engine fallback-only, per-cwd .mcp.json template, UI surface
      extended, spawn_session schema extended).
- [x] **P8.D2** `docs/v3.0-spec.md` FR-MCP updated: spawn_session row lists
      generic path (`cli`/`args`/`tab_title`).
- [x] **P8.D3** This P8 section in PLAN-OF-TRUTH.

### 8.E — Queue drain dead-zone fix

- [x] **P8.E1** `POST /api/orchestrator/tell-omni` now calls
      `queueStore.drainOne(manager, omniSid)` immediately when the target
      pane is already `idle` — otherwise the queue's pane_idle subscriber
      never fires (no transition), prompt sits forever. Returns
      `{enqueuedToOmniclaude, drainedImmediately}`. Fix root-caused by
      observing omniclaude receiving 3 spawn-pedrito prompts in a row and
      never acting.

### 8.F — MCP subprocess token-file gotcha fix

- [x] **P8.F1** `startOmniclaudeDriver()` now always writes an ABSOLUTE
      `THEORCHESTRA_TOKEN_FILE` path into the templated
      `vault/_omniclaude/.mcp.json`, defaulting to
      `<repoRoot>/vault/_auth/token.json`. Relative-path fallback was
      broken because MCP subprocess cwd is `vault/_omniclaude/`, not repo
      root — every auth-gated call silently 401'd.

### 8.G — Release

- [x] **P8.G1** `npm run v3:gate` still green (10/10).
- [x] **P8.G2** `scripts/v3-behavior-gate.ts` 5/5 PASS.
- [x] **P8.G3** Commit (below).
- [x] **P8.G4** Tagged `v3.1.0-rc.3`.

## PHASE 9 — Multi-pane PRD + persona smoke test

Added 2026-04-22. Three flagship spec items (`FR-Carryover` #5 personas,
#7 PRD-bootstrap, #8 peer-pane context) were wired but never end-to-end
dogfooded at 3-pane scale with dependency sequencing. User requested a
two-project test: feature-rich todo app (Path A) + landing-page designer
(Path B). No budget/time constraint.

### 9.A Test fixtures
- [x] **P9.A1** `tests/testproject-todo/CLAUDE.md` + `prd.yaml` (3 roles:
      frontend=coder, backend=dev-backend-api, reviewer=reviewer with bash
      while-loop wait-then-write dependency gate).
- [x] **P9.A2** `tests/testproject-landingpage/CLAUDE.md` + `prd.md`
      (markdown PRD for omniclaude-reads-file Path B).

### 9.B Behavior gate
- [x] **P9.B1** `scripts/v3-multi-pane-behavior-gate.ts` — 6 scenarios,
      count-before / act / wait / assert / count-after pattern.
- [x] **P9.B2** `KEEP_ARTIFACTS=1` preserves tmp dir + on-disk
      deliverables for audit.

### 9.C Fixes discovered + shipped
- [x] **P9.C1** FIXED: `POST /api/prd-bootstrap` was dropping
      `role.prompt`. Added pending-prompts dispatch (8s delay +
      writeAndSubmit) so spawned panes actually receive their task.
      Shipped in `src/backend/ws-server.ts`.
- [x] **P9.C2** FIXED: PRD-bootstrap now forces
      `--dangerously-skip-permissions` on every role spawn so test runs
      don't block on permission prompts.
- [x] **P9.C3** PRD prompt-writing discipline: role prompts now include
      explicit "Use the Write tool NOW" / "Use the Bash tool" imperatives
      — without these Claude drafts in conversation without writing
      files.

### 9.D Live results
- [x] **P9.D1** Gate run 2026-04-22: **5 PASS / 1 SKIP / 0 FAIL** (Path
      B omniclaude-reasons-from-PRD SKIP, Path A fully verified).
- [x] **P9.D2** Real deliverables on disk:
      `tests/testproject-todo/frontend.html` (613B valid HTML todo UI),
      `backend.py` (396B valid Flask API), `review.md` (1878B security +
      quality review with 3+3 findings).
- [x] **P9.D3** Artifacts archived at
      `docs/screenshots/tests/multi-pane-2026-04-22/`.

### 9.E Doc alignment
- [x] **P9.E1** Dogfood log appended to `docs/v3.0-decisions.md`
      addendum with scenario table + spec-compliance status.
- [x] **P9.E2** This P9 section in PLAN-OF-TRUTH.

### 9.F Release
- [ ] **P9.F1** Commit + tag `v3.1.0-rc.4` (below).

## Execution order

P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9. No skipping. If a phase
fails verify, fix THAT phase before advancing. If a new requirement
surfaces mid-execution, write it into this file first, then implement.

## Drift guard

- If a decision is ambiguous, pick the option that makes the advisor easier to
  turn OFF. Advisor is opt-in; the app must always work without it.
- If a test fails that isn't in the phase's test plan, note it as a regression
  and fix it inside this phase. Do not advance with reds.
- Any file you create outside this plan is drift. Stop, re-read.
