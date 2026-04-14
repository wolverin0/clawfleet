# clawfleet dashboard

Desktop web UI for the clawfleet multi-agent orchestrator. Vite + React + TypeScript. Talks to the `dashboard-server.cjs` backend over HTTP and SSE.

## What it shows

- **Pane grid** — live pane cards with status badge, agent identity, last 30 lines, action buttons (Prompt / Enter / Y / Kill).
- **Events stream** — server-sent events from `omni-watcher.cjs`: session transitions, `peer_orphaned`, heartbeats.
- **Active tasks panel** — parsed `active_tasks.md` if available.

## Dev

```bash
# terminal 1 — backend
cd ..                       # repo root
node src/dashboard-server.cjs
# dashboard server on :4200

# terminal 2 — frontend (hot-reload)
cd dashboard
npm install
npm run dev
# Vite on :5173, proxies /api to :4200
```

Open http://localhost:5173.

## Production build

```bash
cd dashboard
npm install
npm run build
# produces dashboard/dist/
```

Then the backend (`node src/dashboard-server.cjs`) serves the built SPA from `dashboard/dist/` directly on `:4200`.

## Configuration

Backend env vars:

| Var | Default | Description |
|-----|---------|-------------|
| `DASHBOARD_PORT` | `4200` | HTTP port |
| `ACTIVE_TASKS_PATH` | `../omniclaude/active_tasks.md` | path to the tasks file |
| `OMNICLAUDE_PATH` | `../omniclaude` | fallback base for `ACTIVE_TASKS_PATH` |
| `WATCHER_POLL_MS` | `30000` | inherited by the watcher child when `/api/events` is hit |

## API

See `src/dashboard-server.cjs` — this is an MVP, endpoints:

- `GET /api/panes`
- `GET /api/panes/:id/output?lines=50`
- `GET /api/tasks`
- `GET /api/events` (SSE)
- `POST /api/panes/:id/prompt {text}` — dispatches prompt + auto-enter (A2A hard rule)
- `POST /api/panes/:id/key {key}` — send single key
- `POST /api/panes/:id/kill`
- `POST /api/spawn {cwd}`

## Not yet in the MVP

- A2A flow view (pending corrs, corr timelines) — backend doesn't yet expose `pendingA2A` state
- Claims feed (MemoryMaster integration)
- Authentication (assumes localhost-only)
- Permission-prompt interactive buttons (approve/reject specific tool requests)
- WebSocket for bidirectional state sync

All tracked in Phase 3 roadmap.
