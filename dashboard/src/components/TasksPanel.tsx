import { Task } from '../api';

export function TasksPanel({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return <div className="empty">No active_tasks.md found or no tasks in flight.</div>;
  }
  return (
    <ul>
      {tasks.map((t) => (
        <li key={t.id}>
          <span className="task-id">{t.id}</span>{' '}
          {t.title}
          <span className={`task-status ${t.status}`}>{t.status}</span>
          {t.owner ? <span style={{ color: 'var(--fg-dim)', marginLeft: 8 }}>@ {t.owner}</span> : null}
        </li>
      ))}
    </ul>
  );
}
