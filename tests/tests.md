# theorchestra v3.1.0-rc.1 — End-to-end dogfood

**Date:** 2026-04-21
**Build:** commit 2d2e678 (`v3.1.0-rc.1`)
**Tester:** Claude (acting as the user at their request)
**Verification method:** Playwright MCP (visible Chrome) + HTTP API + file-system checks

## Setup

```bash
# Clean state, fresh test backend on :4301
rm -rf "C:/Users/pauol/AppData/Local/Temp/theorch-dogfood"
mkdir -p "C:/Users/pauol/AppData/Local/Temp/theorch-dogfood/{_sessions,_dec}"

THEORCHESTRA_PORT=4301 \
THEORCHESTRA_OMNICLAUDE=1 \
THEORCHESTRA_TOKEN_FILE=C:/Users/pauol/AppData/Local/Temp/theorch-dogfood/token.json \
THEORCHESTRA_SESSIONS_DIR=C:/Users/pauol/AppData/Local/Temp/theorch-dogfood/_sessions \
THEORCHESTRA_DECISIONS_DIR=C:/Users/pauol/AppData/Local/Temp/theorch-dogfood/_dec \
THEORCHESTRA_CONFIG_FILE=C:/Users/pauol/AppData/Local/Temp/theorch-dogfood/cfg.md \
THEORCHESTRA_TASKS_FILE=C:/Users/pauol/AppData/Local/Temp/theorch-dogfood/tasks.md \
npm run v3:start
```

**Test panes:** `tests/testpane1/` + `tests/testpane2/`, each with a per-pane
`CLAUDE.md` scoped to a simple A2A file-simulation task, spawned via:
```
POST /api/sessions {cli: "cmd.exe", args: ["/c", "claude", "--dangerously-skip-permissions"], cwd, tabTitle}
```

## Test plan (intended flows)

| # | Flow | Result | Notes |
|---|---|---|---|
| 1 | Backend boots with OMNICLAUDE=1 | ✅ PASS (after fix) | Finding #1 fixed |
| 2 | Omniclaude pane spawns, reads CLAUDE.md | ✅ PASS | 275+ bytes streamed |
| 3 | Testpane Claude spawns with `--dangerously-skip-permissions` | ✅ PASS | Both panes booted on Opus 4.7 |
| 4 | Dashboard renders via wterm, auth works | ✅ PASS | 3 panes visible, streaming |
| 5 | User prompt delivers to testpane via pane-card | ✅ PASS | "say hi to pane 2" landed |
| 6 | testpane1 writes A2A simulation file per CLAUDE.md | ✅ PASS | `pane1-to-pane2.txt` created |
| 7 | testpane2 reads the file per CLAUDE.md | ✅ PASS | Reported "Pane 1 says: 'hello from pane 1'" |
| 8 | SSE emitters fire `pane_idle` events | ✅ PASS | 72+ events observed |
| 9 | Omniclaude receives `[EVENT type=pane_idle …]` prompts | ✅ PASS | Verified in its scrollback |
| 10 | Omniclaude decides + calls MCP tools | ❌ FAIL | Finding #3 — wrong MCP target + flood |
| 11 | OmniClaude chat panel populates with asks | ❌ FAIL | Consequence of #10 |
| 12 | Reasoning panel shows advisor-attested decisions | ⚠️ N/A | Advisor off; panel needs omniclaude-aware copy |
| 13 | A2A scanner detects `[A2A from/to]` envelopes | ➖ SKIP | Test used file simulation, not real envelopes |

## Screenshots

- `docs/screenshots/tests/dogfood-01-dashboard-after-login.png` — 3 panes post-login, both testpanes show Claude v2.1.112 Opus 4.7 + bypass permissions.
- `docs/screenshots/tests/dogfood-02-after-both-prompts.png` — testpane1 wrote the file, testpane2 read it back; Events sidebar shows 72 pane_idle events.
- `docs/screenshots/tests/dogfood-03-with-omniclaude-visible.png` — `?include_omni=1` URL loaded (but Sessions tab still filters omniclaude; see Finding #5).

## Findings

### ✅ What actually works (end-to-end, on real Claude panes)

1. **Backend + dashboard** boots cleanly with omniclaude on; auth token flow works; `?token=<t>` URL pre-fills login after form submit.
2. **PTY lifecycle** — Claude with `--dangerously-skip-permissions` spawns correctly via the `cmd.exe /c claude …` wrapper. node-pty/conpty streams bytes.
3. **wterm DOM rendering** — both testpanes visible; ANSI colors + box-drawing render; text selection works natively (DOM).
4. **Per-pane CLAUDE.md** — Claude reads the scoped CLAUDE.md in its cwd and follows the role instructions (wrote `pane1-to-pane2.txt`, read it back on the other pane). This is the A2A-via-shared-filesystem path working.
5. **User prompt → pane** — pane-card textbox delivers text via HTTP /api/sessions/:id/prompt → PtyManager.writeAndSubmit → Claude acts.
6. **SSE emitters** — every idle transition fires a bus event. Event sidebar's filter chips (All/Completed/Permission/Started/Orphaned/Ctx/Stuck/Idle/A2A) render correctly.
7. **Omniclaude spawn + event injection** — pane spawns, CLAUDE.md is on disk, events get formatted as `[EVENT type=pane_idle id=NN ts=iso]\nPane <sid> went idle. …\nRespond with MCP tool calls + a DECISION line.` and injected into the pane via the shared PaneQueueStore. **Observed verbatim in omniclaude's scrollback.**
8. **Rule engine fallback** — orchestrator decision log shows `no_op` verdicts with reason "pane_idle without OK-CONTINUE pattern" for each event. The deterministic path is still wired.

### ❌ Finding #1 — first-boot `--continue` kills omniclaude

**Severity:** critical (was) / fixed.

**Symptom:** on first backend boot, omniclaude pane exited with code 1 and last line `"No conversation found to continue"`. Omniclaude was effectively dead before the first event arrived.

**Root cause:** `claude --continue` with no prior Claude Code session on disk exits immediately. Driver unconditionally passed `--continue`.

**Fix landed in this session** (`src/backend/omniclaude-driver.ts`): sentinel file `vault/_omniclaude/.bootstrapped`. If absent → spawn without `--continue` (first boot). If present → spawn with `--continue` (resume). Sentinel is written after spawn succeeds.

**Verified:** second boot log shows `[omniclaude] spawning with fresh session (first boot)` on clean state, then omniclaude pane stays alive (`status: working` observed).

### ❌ Finding #3 — omniclaude's MCP tools point at the wrong backend

**Severity:** high — blocks the entire autonomous-decision loop.

**Symptom:** omniclaude receives events but does not make observable tool calls (no `ask_user`, no `send_prompt` back to testpanes, no `snapshot_dashboard`). OmniClaude sidebar panel stays empty.

**Root cause:** repo's `/.mcp.json` configures the `wezbridge` MCP server with
hardcoded `THEORCHESTRA_PORT=4800` and
`THEORCHESTRA_TOKEN_FILE=.../test-workspace/token.json`. When Claude Code in
omniclaude's cwd (`vault/_omniclaude/`) walks up to pick up `.mcp.json`, it
connects MCP to whatever is on `:4800` — which in this test was either nothing
(returning HTTP errors) or a stale backend that rejects the token.

**Proposed fix (not yet shipped):** write a dedicated `vault/_omniclaude/.mcp.json` that:
- Resolves port from `THEORCHESTRA_PORT` env, not hardcoded.
- Resolves token file from `THEORCHESTRA_TOKEN_FILE` env, not hardcoded.
- Gets copied into the omniclaude cwd by `startOmniclaudeDriver()` at boot time with the live port/token baked in.

This is a single-file change but it's the difference between omniclaude
"thinks about events" and "actually steers panes."

### ❌ Finding #4 — pane_idle flood

**Severity:** high — makes omniclaude useless in practice.

**Symptom:** Events sidebar shows 72+ `pane_idle` events in ~2 minutes. Every
single `pane_idle` queues one `[EVENT]` prompt for omniclaude. Omniclaude is
perpetually "Frolicking…" because its queue is always backlogged.

**Root cause:** the `status-bar.ts` emitter fires `pane_idle` on every idle
transition, no coalescing. When Claude paints a new status line (even with
no semantic change), it transitions working→idle→working. Each bounce emits.

**Proposed fix (not yet shipped):** coalesce pane_idle per `sessionId` in the
driver layer — debounce 3-5s so bursts count as one event. Or at the queue
layer: drop a pane_idle enqueue if there's an unfired pane_idle already in
the queue for the same sid.

### ❌ Finding #5 — Sessions tab doesn't honor `?include_omni=1`

**Severity:** low — UX paper cut.

**Symptom:** Navigating to `/?token=…&include_omni=1` does not include omniclaude in the Sessions grid. You have to hit `/api/sessions?include_omni=1` directly from curl to see it.

**Root cause:** the frontend's session-fetch helper drops query params when it builds the /api/sessions URL. The backend honors the param; the React client doesn't pass it.

**Proposed fix:** thread `include_omni` through `src/frontend/` fetch wrappers, or add a dedicated **Omni** tab that calls `GET /api/orchestrator/omniclaude` and renders one pane card. The latter matches the plan (P7.A3) better.

### ⚠️ Finding #6 — Reasoning panel disabled-state copy is misleading when omniclaude is on

**Severity:** low — UX.

**Symptom:** Reasoning panel shows "LLM advisor is off. Set THEORCHESTRA_LLM_ADVISOR=1…" even when `THEORCHESTRA_OMNICLAUDE=1` is set and omniclaude is the active reasoner. The panel only checks advisor state, not omniclaude state.

**Proposed fix:** `ReasoningPanel` should call `GET /api/orchestrator/omniclaude`
in addition to `/api/orchestrator/advisor`. If omniclaude is enabled, show its
own status (pane alive? how many events in queue? last DECISION line?) instead
of the advisor disabled message.

### ⚠️ Finding #7 — rule engine and omniclaude both react to same events

**Severity:** medium — design question.

**Symptom:** decisions log has a `no_op pane_idle without OK-CONTINUE pattern`
entry for every pane_idle, produced by the rule engine, AT THE SAME TIME
omniclaude is reasoning about the same event. Two brains on one event. The
rule engine's no-ops are harmless here but a mechanic-class action from rules
could race with an omniclaude decision on the same event.

**Proposed fix:** when the omniclaude pane is alive and the advisor is off,
short-circuit the rule engine's `handle()` for non-self events. The rule
engine remains as a fallback ONLY when omniclaude is down. This is a small
change in `executor.ts` guarded by an `opts.omniSid` option.

## Flows NOT exercised in this run (future test passes)

- **Real A2A envelopes** — both test panes would have to emit literal `[A2A from=… to=… corr=… type=request]` text. Our CLAUDE.mds used filesystem simulation instead.
- **ctx_threshold events** — would need a long Claude session to fill context past 30/40/50/70 %. Not exercised.
- **Auto-handoff** — triggers at ctx=70%. Not exercised.
- **Permission prompt handling** — we bypassed with `--dangerously-skip-permissions`. A real run without bypass would exercise the permission-prompt emitter.
- **Dashboard-action primitive** — omniclaude calling `act_on_ref` to click UI buttons. Not exercised because MCP tools weren't reaching the right backend (Finding #3).
- **Chat escalation** — omniclaude calling `ask_user` to surface to the user. Not exercised, same reason.
- **Self-handoff** — omniclaude's own ctx crossing 70%. Not exercised.

## What to fix next (prioritized)

1. **Finding #3** — dedicated `vault/_omniclaude/.mcp.json` templated with live port/token at spawn time. Single file, highest impact. Without this, the entire "omniclaude as primary" design is just a spectator.
2. **Finding #4** — coalesce `pane_idle` events per sid. 3-5s debounce. Stops the queue flood. Without this, omniclaude can never keep up with any real work.
3. **Finding #7** — gate the rule engine off when omniclaude is on. Eliminates double-processing.
4. **Finding #5** — Omni tab in the dashboard (or `?include_omni=1` plumbed through the React fetch).
5. **Finding #6** — ReasoningPanel aware of omniclaude state.

## Cleanup

Backend processes killed:
```
for pid in $(netstat -ano | grep ":4301 " | awk '{print $5}' | sort -u); do
  taskkill //PID $pid //F
done
```

Test state in `C:/Users/pauol/AppData/Local/Temp/theorch-dogfood/` left for
inspection; can be deleted safely.
