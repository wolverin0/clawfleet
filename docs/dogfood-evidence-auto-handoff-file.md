# Session Handoff — pane-b (v3.0 dogfood)

**Timestamp**: 2026-04-20T14:04:36Z
**Pane**: pane-b (test-workspace)
**Focus**: v3.0 dogfood

## Context

wezbridge is a proactive orchestrator for multiple Claude Code + Codex sessions running in WezTerm panes, with a browser dashboard (v3.0 track) to steer them. This session is a **dogfood test pane** (`test-workspace/pane-b`) — an isolated workspace used to exercise v3.0 features (PaneCard controls, A2A handoff trio, per-pane queue Q+, cross-pane context injection Ctx, MemoryMaster SSE bridge) against a live pane rather than mocks. The pane was triggered by the dashboard's auto-handoff readiness probe (`Ctx at unknown%`); the user then requested a structured handoff file to simulate a clean session transfer.

## Current State

- **Working directory**: `test-workspace/pane-b/`
- **Branch**: `v3.0` (ahead of `main`)
- **Uncommitted changes in repo**: YES, but NONE authored by this session. All `M` and `??` entries predate the pane-b session and belong to the enclosing v3.0 dev branch:
  - `M docs/screenshots/v3.0/playwright-*.png` (21 files — stale Playwright snapshots)
  - `M src/backend/auto-handoff.ts`
  - `M src/backend/handoff-routes.ts`
  - `M src/backend/inject-context.ts`
  - `M src/backend/pane-queue.ts`
  - `M src/backend/pty-manager.ts`
  - `?? bin/omniclaude.js`
  - `?? bin/start-dashboard.js`
  - `?? scripts/debug-streamer.cjs`
- **Files modified THIS session**: none (only the handoff file being written now, inside `test-workspace/pane-b/handoffs/`).
- **Commits THIS session**: none.
- **Recent v3.0 commits on branch** (context, not this session):
  - `9aec168` feat(v3.0): real Q+ and Ctx — per-pane queue + cross-pane context injection
  - `206a5db` feat(v3.0 U2-v2): PaneCard restores v2.7 controls — handoff trio, keys strip, Q+/Ctx/Mode
  - `4ae75a5` feat(v3.0): port v2.7 A2A-handoff + handoff-history routes
  - `410022a` feat(v3.0): extend /key alias table to cover full TUI navigation set
  - `0bbf71b` feat(v3.0): v3.0-native MemoryMaster bridge (SSE bus → inbox.jsonl)
- **Build status**: not run this session.
- **Tests**: not run this session.
- **Dev server**: not started by this session. Dashboard (port 4200) status unknown from here.
- **Background processes**: none started by pane-b.
- **Workspace contents of pane-b**: single scratch file `step1.txt` (5 bytes).

## Open Threads

- **Auto-handoff readiness probe fired with `Ctx at unknown%`.** The dashboard asked whether pane-b was at a natural break point. Session replied `READY: Session idle at pane-b with no active task in progress.` No task was mid-flight. The "unknown%" suggests the Ctx parser in `src/backend/inject-context.ts` (or the dashboard's StatusBar reader) could not resolve the ctx percentage for this pane — worth confirming whether that is a parser bug on idle panes or expected behavior when the TUI hasn't rendered a `Ctx:` line yet.
- **Staged-but-uncommitted v3.0 work** on the parent branch (see Current State). The 21 screenshot diffs and 5 backend `.ts` edits belong to whoever is driving the v3.0 PaneCard / Q+ / Ctx / auto-handoff track — confirm ownership before committing anything from pane-b, to avoid accidentally snapshotting someone else's WIP.
- **MemoryMaster SSE → inbox.jsonl bridge** (commit `0bbf71b`) is newly wired; no evidence in this session that it was exercised against pane-b events.

## Next Steps

1. **Verify no mid-task work was dropped elsewhere.** From the repo root run `git status` and `git diff --stat` to confirm the 26 listed paths are the only open edits and that pane-b's handoff file is the sole new entry.
2. **Diagnose the `Ctx at unknown%` signal.** Read `src/backend/inject-context.ts` and the dashboard's pane Ctx resolver (likely in the PaneCard component) to decide whether "unknown" on an idle pane is a bug or expected. If it's a bug, reproduce by idling a fresh pane and capturing the SSE frame.
3. **Decide ownership of the 26 open paths.** Before the next commit from pane-b, either (a) stash pane-b-only work into its own commit scoped to `test-workspace/pane-b/`, or (b) coordinate with the v3.0 driver before touching `src/backend/*.ts` or `docs/screenshots/v3.0/*.png`.
4. **Optionally exercise the A2A handoff trio** from the dashboard against pane-b using this handoff file's `corr=handoff-a3c574` to validate the end-to-end delegation-not-injection pattern.
5. **Do NOT** run `git add -A` from the repo root — it would sweep in unrelated v3.0 WIP. Stage paths explicitly.

## Constraints & Gotchas

- **Global rule**: never commit from pane-b without explicit user approval (CLAUDE.md STOP rule #1).
- **Shared-repo risk**: `test-workspace/pane-b/` is inside the wezbridge repo itself. Any `git` action here affects the whole repo — including the 26 unrelated open paths on branch `v3.0`. Treat the repo as shared with other panes and coordinator sessions.
- **Dashboard restart gotcha** (claim 9428): if the dashboard on :4200 is wedged, killing a single pid is not enough — enumerate ALL `node.exe` procs whose command line matches `dashboard-server` and taskkill each. Relevant if the next session needs to restart the dashboard to debug the Ctx parser.
- **A2A send-key rule**: always follow `send_prompt` with `send_key("enter")`. If no response, send a SECOND `enter` — never resend the prompt body (double-types). Claim 8945.
- **Never send bash via `send_text` into a running Claude/Codex TUI** — typed as a user prompt, not executed. Claim 9193.
- **Git Bash on Windows**: use forward-slash paths and Unix shell syntax; `/dev/null` not `NUL`. Escaping rules differ from CMD.
- The `git status` output shown in the session-start snapshot includes `?? ../` (a bare parent entry) — that is an artifact of running `git status` from a nested worktree location, not an actual untracked dir. Ignore it.

## Relevant Files

Paths are repo-relative (rooted at the `wezbridge` project directory) to avoid leaking absolute user paths:

```
test-workspace/pane-b/handoffs/handoff-20260420T140436Z-a3c574.md   # this file
test-workspace/pane-b/step1.txt                                     # pane-b scratch
src/backend/auto-handoff.ts                                         # auto-handoff readiness probe source
src/backend/handoff-routes.ts                                       # /api handoff endpoints
src/backend/inject-context.ts                                       # Ctx injection — candidate for "unknown%" bug
src/backend/pane-queue.ts                                           # per-pane Q+
src/backend/pty-manager.ts                                          # PTY layer underneath PaneCard
src/dashboard-server.cjs                                            # dashboard HTTP + SSE (canonical frontend host)
src/dashboard.html                                                  # v3.0 single-file frontend (PaneCard, handoff trio)
docs/PLAN-dashboard-v2.3.md                                         # phased plan, most recent shipped baseline
docs/PLAN-dashboard-v2.4-cleanup.md                                 # v2.4 backlog
docs/a2a-protocol.md                                                # A2A envelope format
CLAUDE.md                                                           # project instructions (orchestrator + safety rails)
vault/_orchestrator-worker/CLAUDE.md                                # worker JSON contract (not applicable to pane-b)
```

## Corr ID

`handoff-a3c574`
