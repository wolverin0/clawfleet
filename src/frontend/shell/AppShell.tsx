import { useEffect, useState } from 'react';
import { authedFetch } from '../auth';
import { ActivitySidebar } from '../sidebar/ActivitySidebar';
import { TasksStrip } from './TasksStrip';
import type { SessionRecord } from '@shared/types';

/**
 * U1 — App shell. Ports the v2.7 topbar (`.topbar`) verbatim in structure:
 *   [the orchestra]  Sessions · Live · Desktop · Spawn        ● N  ● N  ● N   CLOCK  ▸
 *
 * Tabs drive a client-side view state; Sessions is the default. The current
 * tab's content is rendered by the caller via the `activeTab` render prop.
 * U2-U6 fill out each tab's body.
 */

export type ShellTab = 'sessions' | 'live' | 'desktop' | 'spawn';

export const SHELL_TABS: ReadonlyArray<{ id: ShellTab; label: string }> = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'live', label: 'Live' },
  { id: 'desktop', label: 'Desktop' },
  { id: 'spawn', label: 'Spawn' },
];

interface StatusCounts {
  idle: number;
  working: number;
  permission: number;
}

function useStatusCounts(refreshMs: number = 3000): StatusCounts {
  const [counts, setCounts] = useState<StatusCounts>({ idle: 0, working: 0, permission: 0 });

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await authedFetch('/api/sessions');
        if (!res.ok) return;
        const sessions = (await res.json()) as SessionRecord[];
        if (cancelled) return;
        // Status summary requires per-session /status calls — acceptable for
        // a topbar counter (≤20 sessions). If that ever becomes a cost,
        // backend can expose a summary endpoint.
        let idle = 0;
        let working = 0;
        let permission = 0;
        await Promise.all(
          sessions.map(async (s) => {
            try {
              const sr = await authedFetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/status`);
              if (!sr.ok) return;
              const detail = (await sr.json()) as { status?: string };
              if (detail.status === 'idle') idle += 1;
              else if (detail.status === 'working') working += 1;
              // Phase 2 "permission" would come from the status-bar emitter;
              // for now treat any non-idle/non-working as permission-y.
              else if (detail.status && detail.status !== 'exited') permission += 1;
            } catch {
              /* per-session best-effort */
            }
          }),
        );
        if (!cancelled) setCounts({ idle, working, permission });
      } catch {
        /* backend down — leave previous counts */
      }
    };
    void tick();
    const handle = setInterval(() => void tick(), refreshMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [refreshMs]);

  return counts;
}

function useClock(): string {
  const [now, setNow] = useState<string>(() => new Date().toLocaleTimeString([], { hour12: false }));
  useEffect(() => {
    const handle = setInterval(() => {
      setNow(new Date().toLocaleTimeString([], { hour12: false }));
    }, 1000);
    return () => clearInterval(handle);
  }, []);
  return now;
}

interface AppShellProps {
  activeTab: ShellTab;
  onTabChange: (tab: ShellTab) => void;
  children: React.ReactNode;
}

export function AppShell({ activeTab, onTabChange, children }: AppShellProps) {
  const counts = useStatusCounts();
  const clock = useClock();

  return (
    <div className="shell">
      <header className="topbar" role="banner">
        <div className="topbar-left">
          <div className="topbar-brand">
            the<span>orchestra</span>
          </div>
          <nav className="topbar-menu" role="navigation" aria-label="Primary">
            {SHELL_TABS.map((t) => (
              <a
                key={t.id}
                data-view={t.id}
                className={activeTab === t.id ? 'active' : ''}
                onClick={() => onTabChange(t.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onTabChange(t.id);
                  }
                }}
              >
                {t.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="topbar-right">
          <div className="topbar-stat" title="idle sessions">
            <span className="dot idle" aria-hidden="true" />
            <span aria-label="idle sessions">{counts.idle}</span>
          </div>
          <div className="topbar-stat" title="working sessions">
            <span className="dot working" aria-hidden="true" />
            <span aria-label="working sessions">{counts.working}</span>
          </div>
          <div className="topbar-stat" title="permission-waiting sessions">
            <span className="dot permission" aria-hidden="true" />
            <span aria-label="permission-waiting sessions">{counts.permission}</span>
          </div>
          <div className="topbar-time" aria-label="current time">
            {clock}
          </div>
        </div>
      </header>
      <div className="shell-split">
        <main className="shell-body">{children}</main>
        <ActivitySidebar />
      </div>
      <TasksStrip />
    </div>
  );
}
