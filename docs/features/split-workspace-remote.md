# Feature: `/split`, `/rename`, `/remote` commands

Three new MCP tools wrap existing `wezterm.cjs` capabilities so OmniClaude can expose them as chat commands.

## New MCP tools

### `split_pane`

Split any existing pane to run a shell, Codex, or any program — NOT just Claude Code (that's what `spawn_session` with `split_from` is for).

```
mcp__wezbridge__split_pane({
  pane_id: 6,
  direction: 'horizontal',     // or 'vertical'
  cwd: '/path/to/worktree',    // optional
  program: 'codex',            // optional
  args: ['--dangerously-bypass-approvals-and-sandbox', 'resume', '--last'],
})
// → { pane_id: <new>, direction, source_pane }
```

### `set_tab_title`

Rename a tab. Best practice when you have ≥2 peer panes on the same project: `<project>-<agent>` (e.g. `app-codex`, `app-claude`).

```
mcp__wezbridge__set_tab_title({ pane_id: 8, title: 'app-claude' })
```

### `spawn_ssh_domain`

Spawn a pane on a WezTerm SSH domain. Domain must be pre-configured in `~/.wezterm.lua`:

```lua
config.ssh_domains = {
  { name = 'prod-vm', remote_address = 'user@host', username = 'user' },
}
```

Then:

```
mcp__wezbridge__spawn_ssh_domain({
  domain: 'prod-vm',
  cwd: '/home/user/app',
  program: 'claude',
  args: ['--continue', '--dangerously-skip-permissions'],
})
```

Runs Claude Code remotely while local OmniClaude can still `send_prompt` / `read_output` / `kill_session` through the pane.

## Telegram command handlers for OmniClaude

Add to `omniclaude/CLAUDE.md` under "Telegram Interaction":

| User says | OmniClaude does |
|-----------|-----------------|
| `/split <project>` | Find a pane in `<project>` via `discover_sessions`. Call `split_pane({ pane_id, direction: 'horizontal', program: 'bash' })`. Reply with the new pane ID + "shell ready next to <project>". |
| `/split <project> claude` | As above but `program: 'claude'`, `args: ['--continue']`. Creates a second Claude pane in the same cwd — typical for A2A peer pairs. |
| `/split <project> codex` | `program: 'codex'`, `args: ['--dangerously-bypass-approvals-and-sandbox', 'resume', '--last']`. |
| `/rename <pane_id> <title>` | Call `set_tab_title({ pane_id, title })`. |
| `/remote <domain> <project>` | Call `spawn_ssh_domain({ domain, cwd: '/<remote project>' })` and then `send_prompt` the initial context. |

## Worktree workflow for multi-pane peer projects

Recommended flow when you want two peers on the same repo without stepping on each other's files:

1. Local: `cd <repo> && git worktree add ../<repo>-claude main`
2. From Telegram or OmniClaude:
   - `spawn_session({ cwd: '<repo>' })` — Codex pane (original worktree)
   - `split_pane({ pane_id: <codex>, program: 'claude', cwd: '<repo>-claude' })` — Claude pane on separate worktree
3. Rename tabs:
   - `set_tab_title({ pane_id: <codex>, title: '<repo>-codex' })`
   - `set_tab_title({ pane_id: <claude>, title: '<repo>-claude' })`

Both panes can now edit files independently; merging happens via PR or rebase, not direct edits.

## Compatibility

Existing running Claude Code sessions must **reload** their MCP server to see the new tools (kill + restart the `wezbridge` MCP, or restart the Claude session). This is an MCP-server-side addition so no global protocol change.

## Not in this MVP

- **`/workspace` command** (group panes into a WezTerm workspace) — `wezterm.cjs` has `spawnInWorkspace` + `listWorkspaces` but the WezTerm CLI workspace commands are patchy. Deferred until WezTerm stabilizes its workspace API.
- **Nested splits** — current API is flat; if you `split_pane` off a pane that's already a split, WezTerm picks a reasonable default but you can't specify "split within the existing split". Deferred.
