# PRD — Landing-page designer (playground)

**Project**: `testproject-landingpage`
**cwd**: `G:/_OneDrive/OneDrive/Desktop/Py Apps/wezbridge/tests/testproject-landingpage`

## Feature summary

A lightweight landing-page *designer* — a web page with editable sections: hero, features (3 cards), testimonials, footer. Each section has sliders to tweak padding, font size, background opacity without editing code. The page stores its current values in `localStorage`, so the user can play with sliders and refresh without losing state.

Not a real product. A **smoke-test deliverable**: enough HTML + CSS + a companion design-review doc to prove three panes cooperated.

## Suggested roles (omniclaude may deviate — use your judgement)

- **frontend developer** — persona best suited to building HTML + inline CSS. Deliverable: `landing.html` in the project cwd. A single file, <120 lines, with:
  - 4 sections (hero, features, testimonials, footer)
  - Each section gets an `<input type="range">` slider that binds via vanilla JS to a CSS custom property (`--hero-pad`, etc.)
  - Minimal inline CSS using those custom properties
  - `localStorage` round-trip for slider values

- **design-systems / styling engineer** — persona best suited to design tokens + CSS. Deliverable: `sliders.css` — a standalone CSS file defining default values for the custom properties, a palette, and slider thumb styling. Under 60 lines. Meant to be included with a stub `<link>` in `landing.html` as a progressive-enhancement layer.

- **reviewer** — persona best suited for code/design review. Does NOT bash-poll the filesystem. Waits on **A2A envelopes** from its two siblings (see Coordination below). Deliverable: `review.md` in the cwd with:
  - ## Summary (2 sentences)
  - ## Design feedback (3 bullets: visual consistency, responsive behaviour, slider UX)
  - ## Technical feedback (2 bullets: maintainability, accessibility)

## Coordination (omniclaude is the conductor)

Omniclaude chooses the three personas from `~/.claude/agents/`. Reasonable picks:
- `coder` or a framework-specific frontend persona for the builder role
- any designer / CSS-focused persona available, else `coder` again with a styling-only brief
- `reviewer` for the review role

### Spawn protocol

Every spawn uses `mcp__wezbridge__spawn_session` with:
- `persona`, `cwd=<project-cwd>`, `prompt=<role-specific task>`
- **`spawned_by_pane_id=<your-own-omniclaude-sid>`** (non-negotiable — without it the `[PEER-PANE CONTEXT]` is NOT injected and the pane has no way to A2A back)
- `dangerously_skip_permissions: true`

### Envelope protocol (rewrites the PRD's reviewer spec)

**Frontend + styling** — append to each of their prompts:
```
When your deliverable is complete, emit:
  [A2A from pane-<YOUR_SID> to pane-<COORDINATOR_SID> | corr=<role> | type=result]
  wrote <filename> (<bytes> bytes)
Then send_key enter. Then stop.
```

**Reviewer** — append to its prompt (omniclaude knows the FRONTEND_SID + STYLING_SID by the time it spawns the reviewer):
```
You are the reviewer. Do NOT read the filesystem yet.
Wait for these two envelopes on your OWN scrollback:
  [A2A from pane-<FRONTEND_SID> ... | type=result]
  [A2A from pane-<STYLING_SID>  ... | type=result]
Poll read_output({session_id: "<YOUR_SID>", lines: 50}) every 30s until both
envelopes are present. Only THEN use the Read tool on landing.html + sliders.css
and write review.md. After saving, emit:
  [A2A from pane-<YOUR_SID> to pane-<COORDINATOR_SID> | corr=reviewer | type=result]
  wrote review.md
Then stop.
```

Omniclaude watches its own scrollback for the three `type=result` envelopes. When all three land, emit `DECISION: prd-orchestration-complete — testproject-landingpage` and stop.

## Constraints

- Each deliverable must be a single file in the project cwd.
- `--dangerously-skip-permissions` is in effect for every spawned pane.
- Reviewer MUST block until `landing.html` AND `sliders.css` both exist on disk before writing `review.md`.
- No git commits, no npm install, no network calls. File-system only.
