import { WatcherEvent } from '../api';

const severityClass = (sev?: string) => {
  if (sev === 'P0') return 'event p0';
  if (sev === 'P1') return 'event p1';
  return 'event info';
};

export function EventsStream({ events }: { events: WatcherEvent[] }) {
  if (events.length === 0) {
    return <div className="empty">Waiting for watcher events…</div>;
  }
  return (
    <div className="events">
      {events.map((e, i) => (
        <div key={i} className={severityClass(e.severity)}>
          <div>
            <span className="event-src">{e.source}</span>{' '}
            <span className="event-name">{e.event}</span>
            {e.project ? ` · ${e.project}` : ''}
            {e.pane ? ` · pane-${e.pane}` : ''}
          </div>
          {e.details ? <div style={{ color: 'var(--fg-dim)', fontSize: 10 }}>{String(e.details).slice(0, 120)}</div> : null}
          <div className="event-ts">{new Date(e.ts).toLocaleTimeString()}</div>
        </div>
      ))}
    </div>
  );
}
