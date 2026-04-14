import { Pane } from '../api';
import { PaneCard } from './PaneCard';

export function PaneGrid({ panes, onChange }: { panes: Pane[]; onChange: () => void }) {
  if (panes.length === 0) {
    return <div className="empty">No panes detected. Launch a Claude / Codex session in WezTerm.</div>;
  }
  return (
    <div className="pane-grid">
      {panes.map((p) => <PaneCard key={p.pane_id} pane={p} onChange={onChange} />)}
    </div>
  );
}
