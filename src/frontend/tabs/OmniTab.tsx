import { useEffect, useState } from 'react';
import { authedFetch } from '../auth';

/**
 * P7.A3 + Finding #5 fix — Omni tab.
 *
 * Surfaces the omniclaude pane (which is filtered from the default Sessions
 * list). Shows enable-state + session record + a scrollback tail that the
 * user can inspect to see omniclaude's DECISION lines live.
 *
 * Polls /api/orchestrator/omniclaude every 2s for status, and the pane's
 * /output?lines=40 endpoint for recent scrollback.
 */

interface SessionRecord {
  sessionId: string;
  cli: string;
  cwd: string;
  tabTitle: string;
  pid: number;
  spawnedAt: string;
}

interface OmniStatus {
  enabled: boolean;
  session: SessionRecord | null;
  note?: string;
}

interface StatusDetail {
  status: 'idle' | 'working' | 'exited';
  ctxPercent: number | null;
  exitCode: number | null;
}

export function OmniTab() {
  const [omni, setOmni] = useState<OmniStatus | null>(null);
  const [detail, setDetail] = useState<StatusDetail | null>(null);
  const [tail, setTail] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [promptText, setPromptText] = useState('');
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const sessionId = omni?.session?.sessionId ?? null;

  async function sendKey(key: string): Promise<void> {
    if (!sessionId) return;
    try {
      const r = await authedFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/key`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        },
      );
      setFlash(r.ok ? `key "${key}" sent` : `key send failed`);
    } catch {
      setFlash('key send error');
    }
    setTimeout(() => setFlash(null), 2000);
  }

  async function sendPrompt(): Promise<void> {
    const text = promptText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await authedFetch('/api/orchestrator/tell-omni', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (r.ok) {
        setPromptText('');
        setFlash('prompt sent');
      } else {
        setFlash(`send failed: ${r.status}`);
      }
    } catch {
      setFlash('send error');
    } finally {
      setSending(false);
      setTimeout(() => setFlash(null), 2000);
    }
  }

  useEffect(() => {
    let alive = true;

    async function pull(): Promise<void> {
      try {
        const omniRes = await authedFetch('/api/orchestrator/omniclaude');
        if (!alive) return;
        if (!omniRes.ok) throw new Error(`omniclaude HTTP ${omniRes.status}`);
        const omniBody = (await omniRes.json()) as OmniStatus;
        setOmni(omniBody);

        if (omniBody.session) {
          const [statusRes, outputRes] = await Promise.all([
            authedFetch(`/api/sessions/${encodeURIComponent(omniBody.session.sessionId)}/status`),
            authedFetch(`/api/sessions/${encodeURIComponent(omniBody.session.sessionId)}/output?lines=60`),
          ]);
          if (!alive) return;
          if (statusRes.ok) {
            const st = (await statusRes.json()) as StatusDetail;
            setDetail(st);
          }
          if (outputRes.ok) {
            const out = (await outputRes.json()) as { lines: string[] };
            setTail(out.lines ?? []);
          }
        } else {
          setDetail(null);
          setTail([]);
        }
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    }

    void pull();
    const t = setInterval(pull, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (error) return <div className="omni-tab-error">omni tab: {error}</div>;
  if (!omni) return <div className="omni-tab-loading">loading omniclaude status…</div>;

  if (!omni.enabled) {
    return (
      <div className="omni-tab-disabled">
        <h2>Omni</h2>
        <p>
          Omniclaude is off. Restart theorchestra with{' '}
          <code>THEORCHESTRA_OMNICLAUDE=1</code> (and <code>claude</code> on PATH)
          to enable the persistent orchestrator pane.
        </p>
      </div>
    );
  }

  if (!omni.session) {
    return (
      <div className="omni-tab-disabled">
        <h2>Omni</h2>
        <p>Omniclaude is enabled but its pane is not registered. {omni.note ?? ''}</p>
      </div>
    );
  }

  // Filter ANSI control + OSC + mode-set sequences but PRESERVE SGR (color)
  // sequences — those get converted to HTML spans below so the Omni scrollback
  // renders with the same colors Claude CLI shows in its own terminal.
  // The negative-lookahead excludes `\x1b[...m` (SGR) from the strip pass.
  const ANSI_NON_SGR_RE =
    /\x1b(?:\[(?![?0-9;]*m)[?0-9;]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
  // Collapse carriage-return overwrites: \r in terminal output means "move
  // cursor to start of line" — subsequent chars overwrite what was there.
  // Claude CLI's spinner emits many \r-separated frames per line; without
  // collapsing, we show every redraw as text and the scrollback bloats with
  // "Slithering... Slithering... Slithering..." spam. Keep only the LAST
  // post-\r segment on each line (what the terminal would actually show).
  const collapseCR = (s: string): string => {
    if (!s.includes('\r')) return s;
    const parts = s.split('\r');
    return parts[parts.length - 1] ?? '';
  };
  // Status-bar boilerplate that Claude CLI repaints on every turn — stripped
  // from the conversational scrollback because all of this info is already
  // shown in the pills at the top (sid, status, ctx%). Keeping it inline
  // causes the "duplicated 3 times, unreadable" feed the user complained
  // about since alt-screen frames accumulate in the backend ring buffer.
  const STATUS_BAR_PATTERNS = [
    /^─{10,}$/,
    /^Model:\s.*Thinking:/,
    /^Ctx:\s*\d+(\.\d+)?%.*Context:/,
    /^cwd:\s.*(Reset|Session|Weekly):/,
    /^⏵⏵\s*(bypass permissions|auto mode)/,
    /^⏵⏵\s/,
    /^⏸⏸\s/,
    /^Calling plugin:.*ctrl\+o to expand/,
    /^Called plugin:.*ctrl\+o to expand/,
    /^Thinking:\s*(high|medium|low|minimal|auto)/,
    /^\s*Tip: Run tasks in the cloud/,
    /^\s*\?\s*for shortcuts/,
    /^\s*\(running stop hook/,
  ];
  const isStatusBarLine = (l: string): boolean => STATUS_BAR_PATTERNS.some((re) => re.test(l.trim()));

  // Strip control chars BUT keep \x1b (ESC, 0x1b) so SGR sequences survive
  // to the ansiToHtml pass below. We KEEP blank lines to preserve the visual
  // spacing Claude CLI uses between output blocks — then collapse runs of
  // blanks to a single spacer below.
  const stripSgr = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  const rawClean = tail
    .map((l) => l.replace(ANSI_NON_SGR_RE, ''))
    .map(collapseCR)
    .map((l) => l.replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, ' '))
    .filter((l) => !isStatusBarLine(stripSgr(l)));

  // Dedupe consecutive identical lines (the ❯ [BOOT] prompt echo gets
  // repainted by every turn too; after status-bar strip, consecutive dupes
  // are a clean signal to collapse to one) AND collapse runs of blank lines
  // to at most ONE — preserves Claude CLI's visual paragraph spacing without
  // letting alt-screen padding produce 5+ blanks in a row.
  const cleanTail: string[] = [];
  let prevWasBlank = true; // treat start as blank so leading blanks drop
  for (const line of rawClean) {
    const norm = stripSgr(line).trim();
    const isBlank = norm.length === 0;
    if (isBlank) {
      if (!prevWasBlank) cleanTail.push('');
      prevWasBlank = true;
      continue;
    }
    const prev = cleanTail[cleanTail.length - 1];
    if (prev !== undefined && stripSgr(prev).trim() === norm) continue;
    cleanTail.push(line);
    prevWasBlank = false;
  }
  // Trim trailing blanks
  while (cleanTail.length > 0 && stripSgr(cleanTail[cleanTail.length - 1]!).trim() === '') {
    cleanTail.pop();
  }

  // ─── ANSI SGR (colour) → HTML ─────────────────────────────────────────
  // Claude CLI emits standard 8/16/256/truecolor SGR codes for its badges,
  // diff output, syntax highlighting, etc. Converting to HTML spans lets us
  // preserve the visual meaning that was lost when we stripped ANSI blindly.
  const FG: Record<number, string> = {
    30: '#2e3440', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b', 34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#d0d4da',
    90: '#5c6370', 91: '#ff7b7b', 92: '#a7e3a3', 93: '#f2d27b', 94: '#7cc4ff', 95: '#e491ee', 96: '#66d9d0', 97: '#ffffff',
  };
  const BG: Record<number, string> = {
    40: '#2e3440', 41: '#7a2a2a', 42: '#2a5a2a', 43: '#6a4e1a', 44: '#1e3a5f', 45: '#5a2a5a', 46: '#1e4a4a', 47: '#6a6a6a',
    100: '#44484f', 101: '#b04848', 102: '#4aa34a', 103: '#b38a2a', 104: '#3a6ba8', 105: '#a04aa0', 106: '#3a8080', 107: '#9a9ea0',
  };
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  interface SgrStyle { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }
  const openSpan = (st: SgrStyle): string => {
    const styles: string[] = [];
    if (st.fg) styles.push(`color:${st.fg}`);
    if (st.bg) styles.push(`background:${st.bg}`);
    if (st.bold) styles.push('font-weight:600');
    if (st.dim) styles.push('opacity:0.65');
    if (st.italic) styles.push('font-style:italic');
    if (st.underline) styles.push('text-decoration:underline');
    return styles.length > 0 ? `<span style="${styles.join(';')}">` : '';
  };
  const closeSpan = (st: SgrStyle): string =>
    (st.fg || st.bg || st.bold || st.dim || st.italic || st.underline) ? '</span>' : '';
  const ansiToHtml = (line: string): string => {
    let out = '';
    let pos = 0;
    let style: SgrStyle = {};
    while (pos < line.length) {
      const ix = line.indexOf('\x1b[', pos);
      if (ix === -1) {
        out += openSpan(style) + esc(line.slice(pos)) + closeSpan(style);
        break;
      }
      if (ix > pos) out += openSpan(style) + esc(line.slice(pos, ix)) + closeSpan(style);
      const end = line.indexOf('m', ix + 2);
      if (end === -1) { pos = ix + 2; continue; }
      const raw = line.slice(ix + 2, end);
      const params = raw.length === 0 ? [0] : raw.split(';').map((p) => Number.parseInt(p, 10) || 0);
      for (let i = 0; i < params.length; i++) {
        const p = params[i]!;
        if (p === 0) style = {};
        else if (p === 1) style.bold = true;
        else if (p === 2) style.dim = true;
        else if (p === 3) style.italic = true;
        else if (p === 4) style.underline = true;
        else if (p === 22) { style.bold = false; style.dim = false; }
        else if (p === 23) style.italic = false;
        else if (p === 24) style.underline = false;
        else if (p === 38 && params[i + 1] === 2) {
          const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0;
          style.fg = `rgb(${r},${g},${b})`; i += 4;
        } else if (p === 48 && params[i + 1] === 2) {
          const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0;
          style.bg = `rgb(${r},${g},${b})`; i += 4;
        } else if (p === 38 && params[i + 1] === 5 && params[i + 2] !== undefined) {
          style.fg = FG[params[i + 2]!] ?? '#d0d4da'; i += 2;
        } else if (p === 48 && params[i + 1] === 5 && params[i + 2] !== undefined) {
          style.bg = BG[params[i + 2]!] ?? undefined; i += 2;
        } else if (p === 39) delete style.fg;
        else if (p === 49) delete style.bg;
        else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) style.fg = FG[p];
        else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) style.bg = BG[p];
      }
      pos = end + 1;
    }
    return out;
  };

  const decisionLines = cleanTail.filter((l) => /DECISION:/.test(l));

  return (
    <div className="omni-tab">
      <div className="omni-header">
        <h2>Omni</h2>
        <div className="omni-meta">
          <span className="omni-pill">sid {omni.session.sessionId.slice(0, 8)}</span>
          <span className="omni-pill">{omni.session.cli}</span>
          {detail && (
            <>
              <span className={`omni-pill status-${detail.status}`}>{detail.status}</span>
              {detail.ctxPercent !== null && (
                <span className="omni-pill">ctx {detail.ctxPercent}%</span>
              )}
              {detail.exitCode !== null && (
                <span className="omni-pill warn">exit {detail.exitCode}</span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Omni tab toolbar — same capabilities the Desktop pane card has. */}
      <div className="omni-toolbar" role="toolbar" aria-label="Omniclaude controls">
        <div className="omni-keys">
          <button type="button" className="dwin-btn" onClick={() => void sendKey('escape')} title="Send Escape">ESC</button>
          <button type="button" className="dwin-btn" onClick={() => void sendKey('up')} title="Arrow up">↑</button>
          <button type="button" className="dwin-btn" onClick={() => void sendKey('down')} title="Arrow down">↓</button>
          <button type="button" className="dwin-btn" onClick={() => void sendKey('left')} title="Arrow left">←</button>
          <button type="button" className="dwin-btn" onClick={() => void sendKey('right')} title="Arrow right">→</button>
          <button type="button" className="dwin-btn" onClick={() => void sendKey('tab')} title="Tab">Tab</button>
          <button type="button" className="dwin-btn" onClick={() => void sendKey('enter')} title="Enter">Enter</button>
          <button type="button" className="dwin-btn dwin-btn-kill" onClick={() => void sendKey('ctrl+c')} title="Send Ctrl+C (interrupt one turn — do NOT press twice, that exits)">^C</button>
          <button type="button" className="dwin-btn" onClick={() => void sendKey('1')} title="Send 1 (permission yes)">1</button>
          <button type="button" className="dwin-btn" onClick={() => void sendKey('2')} title="Send 2">2</button>
          <button type="button" className="dwin-btn" onClick={() => void sendKey('3')} title="Send 3">3</button>
          {flash && <span className="omni-flash">{flash}</span>}
        </div>
        <div className="omni-prompt-row">
          <input
            type="text"
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendPrompt();
              }
            }}
            placeholder="Tell omniclaude something (press Enter to send)"
            className="omni-prompt-input"
            disabled={sending}
          />
          <button
            type="button"
            className="dwin-btn"
            onClick={() => void sendPrompt()}
            disabled={sending || promptText.trim().length === 0}
          >
            {sending ? '…' : 'Send'}
          </button>
        </div>
      </div>

      {decisionLines.length > 0 && (
        <div className="omni-decisions">
          <h3>Recent DECISION lines</h3>
          <ul>
            {decisionLines.slice(-10).map((l, i) => (
              <li key={i}>{l.trim()}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="omni-scrollback">
        <h3>Scrollback tail</h3>
        <pre className="omni-pre">
          {cleanTail.slice(-40).map((l, i) => (
            <div
              key={i}
              className="omni-line"
              dangerouslySetInnerHTML={{ __html: ansiToHtml(l) }}
            />
          ))}
        </pre>
      </div>
    </div>
  );
}
