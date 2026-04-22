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

- **reviewer** — persona best suited for code/design review. MUST wait for both files above to exist before starting. Deliverable: `review.md` in the cwd with:
  - ## Summary (2 sentences)
  - ## Design feedback (3 bullets: visual consistency, responsive behaviour, slider UX)
  - ## Technical feedback (2 bullets: maintainability, accessibility)

## Coordination

Omniclaude chooses the three personas from `~/.claude/agents/` (72 available). Reasonable picks:
- `coder` or a framework-specific frontend persona for the builder role
- any designer / CSS-focused persona available, else `coder` again with a styling-only brief
- `reviewer` for the review role

Use `spawn_session` MCP with `persona`, `cwd=<project-cwd>`, `prompt=<role-specific task spec>`, and **`spawned_by_pane_id=<your-own-sid>`** so the `[PEER-PANE CONTEXT]` is prepended and each pane knows to report back via A2A to you.

Peers should emit `[A2A from pane-<self> to pane-<you> | corr=<their-role> | type=result]` with the filename + byte count when their deliverable exists.

## Constraints

- Each deliverable must be a single file in the project cwd.
- `--dangerously-skip-permissions` is in effect for every spawned pane.
- Reviewer MUST block until `landing.html` AND `sliders.css` both exist on disk before writing `review.md`.
- No git commits, no npm install, no network calls. File-system only.
