# REMEDIATION — v3.0 pivot to `@wterm/react` + `agent-browser`

**Single source of truth for what's wrong and what we're doing about it.**
This replaces the sprawl of phase-gate + dogfood-evidence .md files.

---

## The actual state (facts)

- v3.0 shipped: React + Vite + node-pty + `@xterm/xterm` + `@xterm/headless`.
- Original plan (`docs/v3.0-spec.md` + `docs/adrs/v3.0-002-frontend-react-vite.md` + `docs/adrs/v3.0-003-active-omniclaude-a11y-events.md`) specified `@wterm/react` + `agent-browser` from vercel-labs.
- I swapped to `@xterm/xterm` without an ADR. `@wterm/react` was never adopted.
- ADR-003 addendum (`docs/adrs/v3.0-003-addendum-xterm-headless.md`) documented the `agent-browser` → `@xterm/headless` pivot. The reasons given (Rust binary distribution pain, Chromium RSS) were real but missed the whole point of `agent-browser` — it's an AI-ergonomic control surface (semantic locators, element refs, snapshots), not "another browser."
- Result today: v3.0 is a React rewrite of v2.7. Not the architectural shift promised.

## What we actually want (the spec, re-affirmed)

1. Each pane rendered via `@wterm/react` — DOM-based terminal with real a11y tree, native selection/find, WASM-Zig core.
2. Omniclaude observes + acts on the dashboard via `agent-browser` — semantic locators, snapshot-based element refs (`@e1`, `@e2`), not VT byte parsing.

## Migration plan — small verifiable steps

1. **Add deps.** `npm i @wterm/react @wterm/core`. Keep `@xterm/xterm` until step 4.
2. **Swap `src/frontend/Terminal.tsx` renderer** to `@wterm/react`'s `<Terminal/>`, wire WebSocket via `@wterm/core`'s transport. Pane input/output stays identical; only the visual surface changes.
3. **Verify Phase 11 Playwright gate** (`scripts/v3-phase11-playwright.ts`) stays 21/21. Fix any selectors that break on the new DOM structure.
4. **Drop `@xterm/xterm`** from `package.json`. Keep `@xterm/headless` — the SSE emitter path still uses it and that's unchanged.
5. **Install `agent-browser`** as an opt-in dev/runtime dep (prebuilt Rust binary per platform via `prebuild-install` OR separate manual install documented clearly).
6. **Wire orchestrator observation** to agent-browser: replace (or complement) the `@xterm/headless` scan loop with an agent-browser snapshot that returns the dashboard a11y tree + per-pane semantic locators.
7. **Add one agent-browser action path**: orchestrator can call "click ✕ on pane-b" via semantic locator, proving the action loop works end-to-end.
8. **Phase 11 perf gate**: agent-browser snapshot of 10 panes ≤ 500ms (NFR-Perf-3 from `v3.0-spec.md`).
9. **ADRs.** Write `v3.0-002-addendum-wterm-react.md` ("we briefly used xterm.js; re-adopting @wterm/react because …"). Amend `v3.0-003-addendum-xterm-headless.md` to note agent-browser is coming back in and why.

## Non-goals

- Rolling back the React port. Stays.
- Rewriting handoff / auto-handoff / queue / inject-context. All shipping, don't touch.
- Swapping the PTY substrate. node-pty stays.

## Definition of done

- `@wterm/react` is the terminal renderer in the dashboard — no `@xterm/xterm` imports in `src/frontend/`.
- `agent-browser` snapshot reads the live dashboard DOM, returns per-pane a11y-tree with element refs.
- orchestrator fires at least one agent-browser-driven action end-to-end.
- Phase 11 Playwright gate green.
- Two ADRs written/amended (step 9 above).

## Doc cleanup rule

One doc per architectural decision (the ADRs in `docs/adrs/`). One plan (this file). One test log (`docs/v3.0-test-log.md`). MemoryMaster holds the incident/bug/dogfood trail. **No new `dogfood-evidence-*.md` or `phase-N-gate.md` files** — those belong in commit messages and MemoryMaster claims.
