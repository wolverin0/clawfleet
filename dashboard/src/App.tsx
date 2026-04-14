import { useEffect, useState, useCallback } from 'react';
import { api, openEventStream, Pane, Task, WatcherEvent } from './api';
import { PaneGrid } from './components/PaneGrid';
import { EventsStream } from './components/EventsStream';
import { TasksPanel } from './components/TasksPanel';

export function App() {
  const [panes, setPanes] = useState<Pane[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<WatcherEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshPanes = useCallback(async () => {
    try {
      const r = await api.listPanes();
      setPanes(r.panes);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      const r = await api.listTasks();
      setTasks(r.tasks || []);
    } catch { /* silent — tasks are optional */ }
  }, []);

  useEffect(() => {
    refreshPanes();
    refreshTasks();
    const paneTimer = setInterval(refreshPanes, 5000);
    const taskTimer = setInterval(refreshTasks, 15000);
    const stop = openEventStream((ev) => {
      setEvents((prev) => [ev, ...prev].slice(0, 80));
      // Opportunistic refresh on important events
      if (['session_started', 'session_removed', 'peer_orphaned'].includes(ev.event)) {
        refreshPanes();
      }
    });
    return () => { clearInterval(paneTimer); clearInterval(taskTimer); stop(); };
  }, [refreshPanes, refreshTasks]);

  return (
    <div className="app">
      <header className="header">
        <h1>theorchestra</h1>
        <span className="badge">
          {panes.length} pane{panes.length === 1 ? '' : 's'}
          {error ? ` · ${error}` : ''}
        </span>
      </header>
      <main className="main">
        <PaneGrid panes={panes} onChange={refreshPanes} />
      </main>
      <aside className="sidebar">
        <h2>Events</h2>
        <EventsStream events={events} />
      </aside>
      <section className="tasks">
        <h2>Active tasks</h2>
        <TasksPanel tasks={tasks} />
      </section>
    </div>
  );
}
