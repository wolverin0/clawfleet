import { useEffect, useRef, useState } from 'react';
import { authedFetch } from '../auth';

/**
 * U4 — bottom Active Tasks strip. Polls /api/tasks every 5s and renders:
 *   "● Active tasks · N pending · M in progress · K completed"
 *
 * When empty, shows a muted "No active tasks".
 */

interface TaskRec {
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'stuck' | 'cancelled' | 'unknown';
  owner: string | null;
}

export function TasksStrip() {
  const [tasks, setTasks] = useState<TaskRec[]>([]);
  const [reachable, setReachable] = useState<boolean>(true);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await authedFetch('/api/tasks');
        if (!res.ok) {
          if (!cancelledRef.current) setReachable(false);
          return;
        }
        const body = (await res.json()) as { tasks: TaskRec[] };
        if (cancelledRef.current) return;
        setTasks(body.tasks);
        setReachable(true);
      } catch {
        if (!cancelledRef.current) setReachable(false);
      }
    };
    void poll();
    const handle = setInterval(() => void poll(), 5000);
    return () => {
      cancelledRef.current = true;
      clearInterval(handle);
    };
  }, []);

  const counts = {
    pending: tasks.filter((t) => t.status === 'pending').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    stuck: tasks.filter((t) => t.status === 'stuck').length,
  };

  const total = tasks.length;
  const activeDot = counts.in_progress > 0 ? 'working' : counts.stuck > 0 ? 'permission' : 'idle';

  return (
    <div className="tasks-strip" role="status" aria-live="polite">
      <span className={`dot ${activeDot}`} aria-hidden="true" />
      {total === 0 ? (
        <span className="tasks-strip-empty">No active tasks</span>
      ) : (
        <span className="tasks-strip-summary">
          <strong>{total}</strong> active tasks ·{' '}
          <span className="tasks-strip-stat">{counts.pending} pending</span> ·{' '}
          <span className="tasks-strip-stat">{counts.in_progress} in progress</span>
          {counts.completed > 0 && (
            <>
              {' '}·{' '}
              <span className="tasks-strip-stat tasks-strip-completed">
                {counts.completed} completed
              </span>
            </>
          )}
          {counts.stuck > 0 && (
            <>
              {' '}·{' '}
              <span className="tasks-strip-stat tasks-strip-stuck">{counts.stuck} stuck</span>
            </>
          )}
        </span>
      )}
      {!reachable && <span className="tasks-strip-err">(tasks file unreadable)</span>}
    </div>
  );
}
