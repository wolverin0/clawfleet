import { useEffect, useState } from 'react';
import { api, Pane } from '../api';

export function PaneCard({ pane, onChange }: { pane: Pane; onChange: () => void }) {
  const [output, setOutput] = useState<string>('');

  useEffect(() => {
    let alive = true;
    const fetchOut = () => api.paneOutput(pane.pane_id, 30).then(r => { if (alive) setOutput(r.lines); }).catch(() => {});
    fetchOut();
    const t = setInterval(fetchOut, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [pane.pane_id]);

  const statusClass = `status-pill ${pane.status || 'unknown'}`;
  const projectName = pane.project_name || pane.project?.split(/[/\\]/).pop() || '—';
  const identity = pane.is_claude ? 'claude' : (pane.title?.toLowerCase().includes('gpt') ? 'codex' : '?');

  const kill = async () => {
    if (!confirm(`Kill pane ${pane.pane_id} (${projectName})?`)) return;
    await api.killPane(pane.pane_id);
    onChange();
  };

  const sendEnter = () => api.sendKey(pane.pane_id, 'enter');
  const sendY = () => api.sendKey(pane.pane_id, 'y');

  const prompt = async () => {
    const text = window.prompt(`Send prompt to pane ${pane.pane_id}:`);
    if (text) {
      await api.sendPrompt(pane.pane_id, text);
      onChange();
    }
  };

  return (
    <article className="pane-card">
      <div className="pane-card__head">
        <span>
          <span className="project">[{projectName}]</span>{' '}
          <span className="identity">{identity}</span>{' '}
          <span style={{ color: 'var(--fg-dim)' }}>· pane-{pane.pane_id}</span>
        </span>
        <span className={statusClass}>{pane.status || 'unknown'}</span>
      </div>
      <div className="pane-card__body">{output || <span style={{ color: 'var(--fg-dim)' }}>(no output yet)</span>}</div>
      <div className="pane-card__foot">
        <button onClick={prompt}>Prompt</button>
        <button onClick={sendEnter}>Enter</button>
        <button onClick={sendY}>Y</button>
        <button className="danger" onClick={kill}>Kill</button>
      </div>
    </article>
  );
}
