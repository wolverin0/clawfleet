import { useMemo, useState } from 'react';
import { useSseEvents } from '../useSseEvents';
import { OmniClaudePanel } from './OmniClaudePanel';
import { A2APanel } from './A2APanel';
import { EventsPanel } from './EventsPanel';
import { ReasoningPanel } from './ReasoningPanel';

/**
 * U3 — right activity sidebar. Three collapsible panels matching v2.x:
 *   1. OmniClaude — user ↔ orchestrator chat (polls /api/chat/messages)
 *   2. A2A       — open correlations (derived from SSE events)
 *   3. Events    — full SSE feed with filter chips
 *
 * The whole sidebar can collapse to a thin rail on the right edge. Each
 * panel can also collapse individually. No drag-reorder yet (v2.7 had it,
 * U6 can port it if the user wants).
 */

type PanelId = 'omni' | 'reasoning' | 'a2a' | 'events';

interface PanelSpec {
  id: PanelId;
  title: string;
}

const PANELS: ReadonlyArray<PanelSpec> = [
  { id: 'omni', title: 'OmniClaude' },
  { id: 'reasoning', title: 'Reasoning' },
  { id: 'a2a', title: 'A2A' },
  { id: 'events', title: 'Events' },
];

export function ActivitySidebar() {
  const events = useSseEvents();
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [panelOpen, setPanelOpen] = useState<Record<PanelId, boolean>>({
    omni: true,
    reasoning: true,
    a2a: true,
    events: true,
  });

  const a2aCount = useMemo(() => {
    const corrs = new Set<string>();
    for (const ev of events) {
      if (ev.type === 'a2a_received' || ev.type === 'peer_orphaned') {
        if (ev.corr) corrs.add(String(ev.corr));
      }
    }
    return corrs.size;
  }, [events]);

  const panelCount = (id: PanelId): number => {
    if (id === 'a2a') return a2aCount;
    if (id === 'events') return events.length;
    return 0;
  };

  if (collapsed) {
    return (
      <aside
        className="activity-sidebar collapsed"
        aria-label="Activity sidebar"
      >
        <button
          type="button"
          className="as-chevron"
          onClick={() => setCollapsed(false)}
          aria-label="Expand activity sidebar"
        >
          ◀
        </button>
        <div className="as-collapsed-rail">
          {PANELS.map((p) => (
            <div key={p.id} className="as-rail-item" title={p.title}>
              {p.title[0]}
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="activity-sidebar" aria-label="Activity sidebar">
      <div className="as-head">
        <span className="as-head-label">ACTIVITY</span>
        <button
          type="button"
          className="as-chevron"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse activity sidebar"
        >
          ▶
        </button>
      </div>
      <div className="as-panels">
        {PANELS.map((p) => {
          const open = panelOpen[p.id];
          const count = panelCount(p.id);
          return (
            <div key={p.id} className={`as-panel ${open ? '' : 'collapsed'}`}>
              <div
                className="as-panel-head"
                onClick={() => setPanelOpen((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                role="button"
                tabIndex={0}
              >
                <span className="as-title">{p.title}</span>
                <span className="as-count">{count}</span>
                <span className="as-collapse-ind">{open ? '▾' : '▸'}</span>
              </div>
              {open && (
                <div className="as-panel-body">
                  {p.id === 'omni' && <OmniClaudePanel />}
                  {p.id === 'reasoning' && <ReasoningPanel />}
                  {p.id === 'a2a' && <A2APanel events={events} />}
                  {p.id === 'events' && <EventsPanel events={events} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
