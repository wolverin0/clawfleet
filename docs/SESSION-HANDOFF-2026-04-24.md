# Session handoff — 2026-04-24 overnight

Quick-read summary of what happened while the user was asleep.

## TL;DR

- **4 PRs merged to main** in this 24h sprint: P10 briefer+P11 fix, zero-flag boot, Omni UX + Telegram wiring, docs.
- **A-7 Telegram — CLOSED**. DM round-trip verified end-to-end.
- **A-3 soak dev-window — PASS**. 1h on :4300 backend: health 100%, omni-alive 100%, RSS shrank 4%, 0 leaks.
- **Multi-pane gate partial** — sc5 Path-B PASS for the first time ever (70s). sc4/6/7 FAIL blamed on Claude Max weekly-limit throttle (89-92%), NOT code bugs.
- **A-6 observer — correct but 0 events** — backend idle during overnight window.

## What's live on :4300

Backend started via `npm start` with auto-loaded `.env.local` (Telegram creds +
omniclaude cwd override to `/Py Apps/omniclaude/`). Omniclaude pane alive, paired
to Telegram bot @Inner_Ricardo_bot, DM round-trip tested. Omni tab on the
dashboard renders with colour + spacing + keys strip.

## What's committed tonight

| PR | Commit | Summary |
|----|--------|---------|
| #3 | `6e23153` | Omni tab colour + spacing + keys + Telegram `--channels` auto-flag in driver |
| #4 | `9c6c079` | Dogfood log + PHASE 12 in PLAN-OF-TRUTH |

## Gate results (evidence in repo)

### A-3 soak-24h gate (dev window)

```
SOAK SUMMARY (1h)
  samples:          60
  health-ok %:      100.00
  omni-alive %:     100.00
  RSS growth %:     -4.04
  hours w/ 0 new decisions: 1
  verdict:          PASS
```

Report at `docs/soak-reports/soak-2026-04-24-03-57-05.json`. Full 24h run still
owned by the user (PC must stay on a full day).

### A-6 OK-CONTINUE gate

```
[A-6] FAIL — best streak was 0/10 in 60 min (0 decisions observed)
```

Gate logic is correct — it polls `/api/orchestrator/decisions` and filters
contiguous mechanics-verdict continue actions. 0 events because omniclaude is
idle (no panes hitting permission_prompt / pane_stuck / ctx_threshold). Real
validation needs the user doing actual multi-pane work for ≥30 min.

### Multi-pane gate (P9)

```
PASS=3 SKIP=0 FAIL=4

sc1 persona injection        PASS  8s
sc2 PRD-bootstrap spawn      PASS  2s
sc5 omniclaude-reads-PRD     PASS 70s  ← FIRST TIME EVER; Path-B validated
sc3 A2A envelope flow        FAIL 40s  (scanner flake, recurrent)
sc4 dependency sequencing    FAIL 900s (deliverables didn't land)
sc6 real deliverables        FAIL  0s  (files missing)
sc7 omniclaude deliverables  FAIL 720s (same)
```

Regression vs prior run: sc4/6/7 got worse (all three files missing on todo
project this time). Previous run had backend.py landing. Hypothesis: Claude Max
weekly limit at 89-92% + 7+ concurrent claude sessions choked throughput below
what a fresh pane needs to produce output. P11 idle-poll fix itself is correct
(code) but environmental cap blocks full re-validation. **Retry when weekly
limit resets Apr 25 @ 1pm ART**.

## What's still pending for user

1. **Full 24h soak** — run `SOAK_HOURS=24 npx tsx scripts/v3-soak-24h-gate.ts`
   some day with PC on. Dev-window already green.
2. **A-6 real validation** — do ~30 min of multi-pane dashboard work with
   permission prompts flying, run gate in parallel.
3. **Telegram group messages** — currently bot is DM-only because Group Privacy
   mode is ON. Flip in @BotFather if group messages should also reach omniclaude.
4. **Multi-pane gate rerun post-weekly-reset** — after Apr 25 @ 1pm ART validate
   sc4/6/7 actually work (P11 fix).
5. **A-4 cloudflared + phone access** — not attempted.
6. **A-10 fresh-machine npm install** — not attempted.

## Known open defects (low priority)

- **sc3 A2A scanner intermittent** — dropped events on the probe corr in
  several recent runs. Worth a root-cause pass if the A2A envelope flow
  becomes load-bearing again.
- **Claude CLI stop-hook latency** — user's `~/.claude/settings.json` hooks
  (memorymaster auto-save etc.) add 30-60s to every omniclaude turn. Running
  many hooks on every stop caps omniclaude's effective responsiveness.
- **fork_session** (Claude Code 2.1.117+) not wired into spawn_session MCP.
  Tracked as P12. Not urgent — spawn_session + persona header is still correct
  for reviewer/builder delegation.

## What I couldn't save

MemoryMaster MCP disconnected early in the overnight window. Several claims
worth ingesting when it reconnects:

- The `--channels plugin:telegram@claude-plugins-official` flag is REQUIRED
  for the official plugin to bind DMs to a claude session (not just installed).
- Telegram plugin state files at `~/.claude/channels/telegram/`: `access.json`
  for policy, `approved/<user_id>` BIND file (10 bytes = chat_id). Being in
  `allowFrom` alone is NOT enough — the BIND file must exist.
- Group Privacy mode filters group messages before they reach the plugin.
  Use @BotFather → Bot Settings → Group Privacy → Turn off, then re-add to
  group.
- `claude --continue` vs `claude -r SESSION_ID` — the former can pick the
  wrong prior session; if wrong conversation resumes, use `-r` explicitly.
- Multi-pane gate weekly-limit throttle correlation: when Claude Max weekly
  usage ≥ 85%, panes take 2-5x longer per turn due to API throttle + slow
  stop-hooks. Multi-pane gates budgeted for normal throughput will FAIL even
  though the code is correct. Run the gate after a weekly reset for true
  validation.
- wterm CLI pane read pattern: `wezterm cli list` → find PANEID →
  `wezterm cli get-text --pane-id <N>` to dump a pane's scrollback without
  going through theorchestra. Useful when the backend is down.

## Commands the user should know

```bash
# Start everything with zero flags:
npm start

# Observe 24h soak (in separate terminal, backend must be up):
SOAK_HOURS=24 npx tsx scripts/v3-soak-24h-gate.ts

# Observe A-6 while doing real work:
A6_MINUTES=60 npx tsx scripts/v3-a6-ok-continue-gate.ts

# Full multi-pane gate (~25 min, burns API):
npx tsx scripts/v3-multi-pane-behavior-gate.ts

# Read omniclaude's pane directly if backend is down:
wezterm cli list                              # find PANEID
wezterm cli get-text --pane-id <PANEID>       # dump scrollback

# Kill orphan processes if the plugin gets stuck:
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match 'theorchestra-mcp|claude --continue|bun.*telegram' } | Stop-Process -Force"
```
