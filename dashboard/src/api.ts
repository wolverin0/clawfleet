// Thin wrapper around the theorchestra dashboard-server HTTP API.

export interface Pane {
  pane_id: number;
  is_claude: boolean;
  status: 'idle' | 'working' | 'permission' | 'unknown' | string;
  project?: string;
  project_name?: string;
  title?: string;
  last_line?: string;
  confidence?: number;
}

export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted' | string;
  owner?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface WatcherEvent {
  ts: string;
  source: string;
  event: string;
  project?: string;
  pane?: number;
  severity?: string;
  details?: string;
  [key: string]: unknown;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  listPanes: () => json<{ panes: Pane[] }>('/api/panes'),
  paneOutput: (id: number, lines = 40) =>
    json<{ pane_id: number; lines: string }>(`/api/panes/${id}/output?lines=${lines}`),
  listTasks: () => json<{ tasks: Task[]; error?: string; note?: string }>('/api/tasks'),
  sendPrompt: (id: number, text: string) =>
    json<{ ok: boolean }>(`/api/panes/${id}/prompt`, { method: 'POST', body: JSON.stringify({ text }) }),
  sendKey: (id: number, key: string) =>
    json<{ ok: boolean }>(`/api/panes/${id}/key`, { method: 'POST', body: JSON.stringify({ key }) }),
  killPane: (id: number) =>
    json<{ ok: boolean }>(`/api/panes/${id}/kill`, { method: 'POST' }),
  spawn: (cwd: string) =>
    json<{ ok: boolean; pane_id: number }>('/api/spawn', { method: 'POST', body: JSON.stringify({ cwd }) }),
};

export function openEventStream(onEvent: (e: WatcherEvent) => void): () => void {
  const src = new EventSource('/api/events');
  src.onmessage = (ev) => {
    try { onEvent(JSON.parse(ev.data)); } catch { /* ignore malformed */ }
  };
  src.onerror = () => { /* browser auto-reconnects */ };
  return () => src.close();
}
