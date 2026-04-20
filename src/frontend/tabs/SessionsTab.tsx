import { useState } from 'react';
import { PaneGrid } from './PaneGrid';
import { BroadcastBar } from '../shell/BroadcastBar';
import { LayoutControls, type LayoutMode } from './LayoutControls';

/**
 * U2 + U4 + U6 — Sessions tab: layout controls + broadcast bar on top,
 * pane-card grid underneath (layout-mode-aware), floating pane badges
 * from BroadcastBar.
 */

export function SessionsTab() {
  const [mode, setMode] = useState<LayoutMode>('tile');
  return (
    <div className={`sessions-tab sessions-tab-grid layout-${mode}`}>
      <div className="sessions-toolbar">
        <LayoutControls mode={mode} onChange={setMode} />
        <BroadcastBar />
      </div>
      <PaneGrid layout={mode} />
    </div>
  );
}
