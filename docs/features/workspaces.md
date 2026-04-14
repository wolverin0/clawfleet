# Feature: Workspace MCP tools + `/workspace` command

Group related panes into WezTerm workspaces. Useful when you have many projects open simultaneously and want to context-switch the whole tab bar at once.

## New MCP tools

### `list_workspaces`

Returns every workspace and the panes it contains:

```
mcp__wezbridge__list_workspaces()
// → { workspaces: [ { name: "default", panes: [1, 3, 6] }, { name: "paperclip", panes: [8, 10] } ] }
```

### `switch_workspace`

Activate a workspace (creates it if missing):

```
mcp__wezbridge__switch_workspace({ name: "paperclip" })
```

### `spawn_in_workspace`

Create a new pane directly in a named workspace:

```
mcp__wezbridge__spawn_in_workspace({
  workspace: "paperclip",
  cwd: "/path/to/paperclip",
  program: "claude",
  args: ["--continue"],
})
// → { pane_id: 42, workspace: "paperclip" }
```

## Telegram command handlers for OmniClaude

| User says | OmniClaude does |
|---|---|
| `/workspace` | Call `list_workspaces`. Reply with the workspace list + pane counts. |
| `/workspace <name>` | Call `switch_workspace({name})`. Reply "switched to \<name\>". |
| `/workspace new <name> <project>` | Call `spawn_in_workspace({ workspace, cwd: <project path>, program: 'claude', args: ['--continue'] })`. |

## Compatibility caveat

WezTerm's workspace CLI support has shifted across versions:

- `listWorkspaces` — widely supported (derives from `wezterm cli list --format json`).
- `switchWorkspace` — needs a recent WezTerm (uses `switch-to-workspace` subcommand).
- `spawnInWorkspace` — uses `spawn --workspace`, supported across modern versions.

If `switch_workspace` returns an error on your WezTerm, either upgrade or use the UI-side default shortcut (`Ctrl+Shift+W` by default) — both approaches call the same internal command.

## Running Claude sessions need to reload the MCP server

This feature ADDS three new tools to the `wezbridge` MCP. Existing Claude Code sessions cache the tool list at startup. To pick up the new tools, either restart the Claude session or have it call `reload` if supported. (Alternative: merge this branch at the next release boundary so new sessions pick it up cleanly.)

## When to use workspaces vs split_pane

- **Workspaces** = context swap (this feature). Useful when you work on unrelated projects in parallel and want to hide one to focus on the other.
- **`split_pane`** (from `theorchestra/feat-split-workspace-remote`) = layout within one workspace. Useful for peer panes on the same project (e.g. Claude + Codex side-by-side).

They compose: a "paperclip" workspace can contain two split panes (codex+claude), and a "dude" workspace can contain its own pair.
