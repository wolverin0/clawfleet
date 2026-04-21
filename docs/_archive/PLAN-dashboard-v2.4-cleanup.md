# Dashboard v2.4 — Backlog cleanup + shipping

**Status**: executing 2026-04-14
**Branch**: `theorchestra/dashboard-v2.2`
**Scope**: clears all 8 items the user flagged after v2.3/v2.3.1 shipped. No new features — finishes what was started.

## The 8 items

### Code
1. **Panel drag-to-reorder** in right activity sidebar — user explicit ask. Drag panel headers, persist to `localStorage['theorchestra:sidebar-panel-order:v1']`. File: `src/dashboard.html`.
2. **Handoff history cold-start scan** — new `GET /api/handoffs?pane=N` endpoint that scans `<pane-cwd>/handoffs/*.md` and returns parsed metadata (filename, source, target, timestamp, corr). Frontend `📜` button merges this with in-memory history. Files: `src/dashboard-server.cjs` + `src/dashboard.html`.
3. **Claude Routines integration scaffolding** — build config loader + orchestrator action WITHOUT requiring user tokens yet. Files to add:
   - `src/routines-config.cjs` — reads `vault/_routines-config.md` (gitignored), parses a simple frontmatter table of `{routine_id, token_env_var, triggers, notes}`.
   - `vault/_routines-config.md.template` — skeleton the user copies + fills in. Tokens come from env vars, never in file.
   - New action type `fire_routine` added to `src/orchestrator-executor.cjs` `classifyAction()` — always escalates (never auto-fires in v1) per plan v2.3.
   - `POST /api/routines/fire` endpoint that forwards to Anthropic's `/v1/claude_code/routines/:id/fire` with the right beta header, using env var token.
4. **A2A arrows SVG overlay** on Desktop view — port `dashboard/src/components/A2AArrows.tsx` logic inline into `src/dashboard.html`. Draw quadratic Bezier curves between active corr pane pairs; color by status (active=accent, resolved=green, orphaned=red). Hook into existing `#desktopArea`.
5. **Cleanup `dashboard/` React folder** — since the HTML v3.1 is canonical and React was abandoned. Decision: archive to `tmp/dashboard-react-v2.1/` rather than delete outright so it's still findable if we ever want to port back. `.gitignore` the archived folder.

### Housekeeping
6. **Push branch** `theorchestra/dashboard-v2.2` to remote with all 3 commits since last push.
7. **Merge to main** — create a PR (or direct fast-forward if possible) so v2.3 lands on `main`. Check if there are conflicts first (there were reverts on main earlier).
8. **Update `CLAUDE.md`** (project root) — current text describes v4 orchestrator only; add: HTML dashboard at `src/dashboard.html` served on :4200, v2.3 sidebar/tasks/handoff features, the handoff delegation pattern (source authors via MCP), where the plan docs live.

## Parallelization strategy (file-ownership split per claim 9439)

| Worker | Files | Items |
|---|---|---|
| Backend agent | `src/dashboard-server.cjs`, `src/orchestrator-executor.cjs`, new `src/routines-config.cjs`, `vault/_routines-config.md.template` | #2 backend + #3 scaffolding |
| Frontend agent | `src/dashboard.html` | #1 drag-reorder + #2 history consumer + #4 A2A arrows |
| Me (orchestrator) | `dashboard/` cleanup, `CLAUDE.md`, git ops | #5 + #6 + #7 + #8 |

Frontend and backend agents run concurrently (different files, zero conflict). I do cleanup + git in parallel while they work.

## Acceptance

Single validation pass at the end:
- All 3 agents + me report done
- Playwright: verify drag-reorder persists across reload, verify A2A arrow draws when an envelope is injected, verify history button lists a previously-created handoff file
- `npm run dashboard` OR direct `node src/dashboard-server.cjs` boots clean, zero console errors, all 4 tabs render
- `git log` shows all new commits, `git push` lands them, `git status` on main clean after merge
- `CLAUDE.md` preview-reads correctly, no broken links to renamed files

## Risks

| Risk | Mitigation |
|---|---|
| Merge conflict with `main` (post-revert divergence) | `git fetch + git log main..HEAD` first; if conflicts, rebase interactively rather than merging |
| Routines API beta header drifts | Pin `experimental-cc-routine-2026-04-01` in a constant; document the unpin process |
| SVG arrow overlay fights with react-rnd-style absolute windows | Arrows are `pointer-events: none` so they don't block drag |
| Archived `dashboard/` folder pulled into future grep noise | `.gitignore` the archived path + add `.dockerignore`-style marker file |
| Drag-reorder breaks when a panel is collapsed | Test collapsed-then-drag explicitly |

## Out of scope (even now)

- Mobile responsive
- Auth
- Touching omniclaude vault contents
- Replacing any MCP tool
- Actual Routines creation at claude.ai (user does that manually after scaffolding lands)
