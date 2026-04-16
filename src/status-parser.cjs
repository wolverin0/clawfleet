/**
 * Shared status-bar parser for Claude Code pane output.
 *
 * Extracts Ctx%, Session%, Weekly%, and model name from the status bar line(s)
 * Claude Code renders at the bottom of each pane. Used by:
 *   - omni-watcher.cjs (periodic metrics emission)
 *   - pane-discovery.cjs (expose per-pane ctx so the dashboard can show badges
 *     and the auto-handoff daemon can decide when to suggest/enforce resets)
 *
 * Returns null when no known fields matched — callers should treat that as
 * "not a Claude Code pane" / "status bar not visible yet".
 */

function parseStatusBar(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
  const ctx = text.match(/Ctx:\s*([\d.]+)%/);
  const session = text.match(/Session:\s*([\d.]+)%/);
  const weekly = text.match(/Weekly:\s*([\d.]+)%/);
  const model = text.match(/Model:\s*([^\s]+)/);
  if (!ctx && !session && !weekly) return null;
  return {
    ctx: ctx ? parseFloat(ctx[1]) : null,
    session: session ? parseFloat(session[1]) : null,
    weekly: weekly ? parseFloat(weekly[1]) : null,
    model: model ? model[1] : 'unknown',
  };
}

module.exports = { parseStatusBar };
