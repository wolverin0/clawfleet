# PRD — Feature-rich todo app (smoke-test deliverable)

**Project**: `testproject-todo`
**cwd**: `G:/_OneDrive/OneDrive/Desktop/Py Apps/wezbridge/tests/testproject-todo`

## Feature summary

A todo app with a working frontend and a Flask REST API — the two halves are built in parallel by two peer panes, then a third pane reviews both outputs. Not a real product — this is a smoke-test deliverable proving a 3-pane team can be orchestrated by omniclaude and coordinate via A2A envelopes instead of filesystem polling.

## Suggested roles (omniclaude may deviate)

### 1. Frontend developer

Pick a persona good at HTML/CSS/JS. Safe choice: `coder`.

Deliverable: `frontend.html` in the project cwd. One self-contained file (inline CSS + inline JS, no frameworks, no build). Features the personas should design:

- Add / edit / delete todos
- Mark complete / incomplete (strikethrough)
- Filter: all / active / completed
- Priority tags (low / medium / high) as coloured badges
- Optional due date
- Live search box
- Keyboard shortcuts (Enter to add, Escape to cancel-edit, `/` to focus search)
- localStorage persistence
- Dark/light theme toggle
- Responsive + accessible (ARIA labels, keyboard-navigable)

Aim ~250-400 lines of real implementation.

### 2. Backend developer

Pick a persona good at Python APIs. Safe choice: `dev-backend-api`.

Deliverable: `backend.py` in the project cwd. One Flask file (no DB, in-memory store). Endpoints:

- `GET /todos` with query params `status`, `priority`, `q` (search text)
- `POST /todos` — validate required `text`, optional `priority`, `due_date`
- `PATCH /todos/<id>` — edit
- `DELETE /todos/<id>` — 404 if not found
- `PUT /todos/<id>/complete` — toggle
- `GET /todos/stats` — `{total, active, completed, by_priority}`
- `/health` returning `{ok: true}`

Include CORS headers, `app.logger` on each mutation, auto-incrementing IDs + `created_at` / `updated_at`. Aim ~120-200 lines.

### 3. Reviewer

Pick a persona good at code review. Safe choice: `reviewer`.

Deliverable: `review.md` in the project cwd.

**CRITICAL**: the reviewer **must not** bash-poll the filesystem. Omniclaude rewrites the reviewer's prompt at spawn time to wait on **A2A envelopes from its two siblings**. When both `type=result` envelopes have landed in the reviewer's scrollback, it reads both files and writes:

- `## Summary` (2-3 sentences)
- `## Security findings` (≥5 bullets)
- `## Quality findings` (≥4 bullets)
- `## Recommended next actions` (≥3 bullets)

Aim ~150-250 lines of markdown.

## Coordination protocol (omniclaude reads this)

1. You (omniclaude) spawn all three panes via `mcp__wezbridge__spawn_session` with `spawned_by_pane_id=<your-sid>`. This prepends `[PEER-PANE CONTEXT]` to each pane's initial prompt, teaching it how to emit A2A envelopes back to you.

2. For **frontend** and **backend**, append this to their PRD prompts:
   ```
   When your deliverable is complete, emit one A2A envelope:
     [A2A from pane-<YOUR_SID> to pane-<COORDINATOR_SID> | corr=<role-name> | type=result]
     wrote <filename> (<bytes> bytes)
   Then send_key enter. Then stop.
   ```

3. For **reviewer**, append this AFTER you've spawned frontend + backend (so you know their SIDs):
   ```
   You are the reviewer. Do NOT read the filesystem yet.
   Wait for these two envelopes on your OWN scrollback:
     [A2A from pane-<FRONTEND_SID> ... | type=result]
     [A2A from pane-<BACKEND_SID>  ... | type=result]
   Poll read_output({session_id: "<YOUR_SID>", lines: 50}) every 30s until both
   envelopes are present. Only THEN use the Read tool on frontend.html + backend.py
   and write review.md. After saving, emit:
     [A2A from pane-<YOUR_SID> to pane-<COORDINATOR_SID> | corr=reviewer | type=result]
     wrote review.md
   Then stop.
   ```

4. Omniclaude watches its own scrollback for the three `type=result` envelopes. When all three arrive, emit one `DECISION: prd-orchestration-complete — testproject-todo` line and stop.

## Constraints

- Each deliverable is a single file in the cwd.
- `--dangerously-skip-permissions` on every spawn.
- No git, no npm install, no network.
- No filesystem-polling loops in prompts. A2A envelopes are the signal path.
