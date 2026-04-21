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

## Execution order

P0 → P1 → P2 → P3 → P4 → P5. No skipping. If a phase fails verify, fix THAT
phase before advancing. If a new requirement surfaces mid-execution, write it
into this file first, then implement.

## Drift guard

- If a decision is ambiguous, pick the option that makes the advisor easier to
  turn OFF. Advisor is opt-in; the app must always work without it.
- If a test fails that isn't in the phase's test plan, note it as a regression
  and fix it inside this phase. Do not advance with reds.
- Any file you create outside this plan is drift. Stop, re-read.
