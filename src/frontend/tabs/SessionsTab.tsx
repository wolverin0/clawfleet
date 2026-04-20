import { PaneGrid } from './PaneGrid';

/**
 * U2 — Sessions tab is now the pane-card grid (one card per live session).
 * The U0 Terminal + ChatPanel is temporarily accessible through the Live
 * tab until U3 ports the full activity sidebar (which is where the chat
 * belongs).
 */

export function SessionsTab() {
  return (
    <div className="sessions-tab sessions-tab-grid">
      <PaneGrid />
    </div>
  );
}
