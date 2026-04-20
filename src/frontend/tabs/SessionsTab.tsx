import { PaneGrid } from './PaneGrid';
import { BroadcastBar } from '../shell/BroadcastBar';

/**
 * U2 + U4 — Sessions tab: broadcast bar on top, pane-card grid underneath,
 * floating pane-badge stack bottom-right (from BroadcastBar).
 */

export function SessionsTab() {
  return (
    <div className="sessions-tab sessions-tab-grid">
      <BroadcastBar />
      <PaneGrid />
    </div>
  );
}
