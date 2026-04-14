# Feature: Project scanner + `/projects` Telegram command

Spawn any Claude Code or Codex CLI session for any project from Telegram, without remembering paths.

## What it does

`src/project-scanner.cjs` enumerates every project that has Claude Code or Codex session history on disk:

- Claude Code: `~/.claude/projects/<url-escaped-cwd>/<uuid>.jsonl`
- Codex CLI:   `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`

For each project it resolves the real cwd (by reading the most recent JSONL's `cwd` field), counts sessions, and records the latest activity timestamp.

## Usage

### As a library (from OmniClaude or the dashboard)

```js
const { scanProjects, formatHuman } = require('./src/project-scanner.cjs');
const projects = scanProjects({ includeCodex: true, limit: 10 });
// → [{ agent, encoded?, realPath, name, sessionCount, latestSessionUuid, latestActivityMs }, …]
```

### As a CLI

```bash
node src/project-scanner.cjs             # human-readable, TTY-detected
node src/project-scanner.cjs --json      # machine-readable (default when piped)
node src/project-scanner.cjs --no-codex  # Claude only
node src/project-scanner.cjs --limit 5   # top-5 by recency
```

Piped to `jq` for quick queries:

```bash
node src/project-scanner.cjs --json | jq '.[] | select(.agent == "codex") | .name'
```

## OmniClaude integration

Add to `omniclaude/CLAUDE.md` under the "Telegram Interaction" section so OmniClaude responds to `/projects` in DM:

```
| "/projects"                 | Run `node /path/to/clawfleet/src/project-scanner.cjs --json --limit 15`.
|                             | Format the top 10 as a Telegram message:
|                             |   `[claude|codex] <name>  ·  N sessions  ·  <age>`
|                             | Offer to spawn with `/spawn <name>` as a follow-up.
| "/spawn <name>"             | Look up the project by name → cwd from the scanner output.
|                             | Call `mcp__wezbridge__spawn_session({ cwd })`.
|                             | For Codex projects, spawn with program="codex" and args=["--dangerously-bypass-approvals-and-sandbox","resume","--last"].
|                             | For Claude projects, spawn with program="claude" and args=["--continue"] OR resume a specific UUID on request.
```

## Output shape

```json
[
  {
    "agent": "claude",
    "encoded": "G---OneDrive-OneDrive-Desktop-Py-Apps-memorymaster",
    "realPath": "G:\\_OneDrive\\OneDrive\\Desktop\\Py Apps\\memorymaster",
    "name": "memorymaster",
    "sessionCount": 12,
    "latestSessionUuid": "18b60491-ebd1-4ef9-bb59-9f8fe6969756",
    "latestActivityMs": 1744586400000
  },
  {
    "agent": "codex",
    "realPath": "G:\\_OneDrive\\OneDrive\\Desktop\\Py Apps\\app",
    "name": "app",
    "sessionCount": 7,
    "latestSessionUuid": "019d8386-563e-72f0-9d91-bd494c1ae328",
    "latestActivityMs": 1744586200000
  }
]
```

## Performance notes

- Reads only the last 30KB of each JSONL to resolve `cwd` — safe on multi-GB logs.
- Path resolution is cached per process (Claude's URL-escape is lossy — some paths can't be decoded structurally, so we read one line of the actual session to be sure).
- Scanning ~50 projects + ~500 Codex rollouts completes in well under 1s on local SSDs.

## Not in this MVP

- **Friendly aliases** — projects keyed by folder basename. Collisions (two `frontend` folders in different parents) resolved by showing the realPath. Phase-4 idea: `~/.omniclaude/project-aliases.json` like the existing `pane-aliases.json`.
- **Filtering by cwd prefix** — e.g. `/projects under Py Apps` — would be a CLI flag or an OmniClaude-side filter.
- **Delete / archive commands** — not dangerous to add but deferred; the scanner is read-only for now.
