import { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { authedFetch } from '../auth';
import { PaneCard } from './PaneCard';
import { LayoutControls, type LayoutMode } from './LayoutControls';

/**
 * Desktop tab — v2.7 parity floating-window layout.
 *
 * Each live pane renders as an absolutely-positioned draggable/resizable
 * window (`.dwin-float`). Drag by the header, resize from the SE corner /
 * E edge / S edge. Positions + sizes persist per session-id in
 * localStorage so refresh restores the layout. Z-order bumps on click.
 *
 * Mirrors v2.7 `src/dashboard.html:1988-2030` which used the same pattern
 * under the Desktop view.
 */

interface WinState {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

const STORAGE_KEY = 'theorchestra.desktop.winstate.v1';
const DEFAULT_W = 520;
const DEFAULT_H = 360;
const MIN_W = 360;
const MIN_H = 220;

function loadWinState(): Record<string, WinState> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, WinState>) : {};
  } catch {
    return {};
  }
}

function saveWinState(state: Record<string, WinState>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota full */
  }
}

function cascadeDefault(index: number): WinState {
  return {
    x: 40 + (index % 6) * 40,
    y: 40 + (index % 6) * 32,
    w: DEFAULT_W,
    h: DEFAULT_H,
    z: 1 + index,
  };
}

/**
 * Auto-arrange helpers — compute per-window positions for each layout
 * mode given the viewport size and the session count. Callers merge
 * these into the existing `wins` map (preserving z) and persist.
 */
const GAP = 12;
const MARGIN = 20;

function arrangeTile(count: number, viewW: number, viewH: number): WinState[] {
  if (count === 0) return [];
  const cols = count <= 2 ? count : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const w = Math.max(MIN_W, Math.floor((viewW - MARGIN * 2 - GAP * (cols - 1)) / cols));
  const h = Math.max(MIN_H, Math.floor((viewH - MARGIN * 2 - GAP * (rows - 1)) / rows));
  return Array.from({ length: count }, (_, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return {
      x: MARGIN + c * (w + GAP),
      y: MARGIN + r * (h + GAP),
      w,
      h,
      z: 0,
    };
  });
}

function arrangeCascade(count: number): WinState[] {
  return Array.from({ length: count }, (_, i) => ({
    x: MARGIN + i * 40,
    y: MARGIN + i * 32,
    w: DEFAULT_W,
    h: DEFAULT_H,
    z: 0,
  }));
}

function arrangeStack(count: number, viewW: number, viewH: number): WinState[] {
  if (count === 0) return [];
  const w = Math.max(MIN_W, viewW - MARGIN * 2);
  const h = Math.max(MIN_H, Math.floor((viewH - MARGIN * 2 - GAP * (count - 1)) / count));
  return Array.from({ length: count }, (_, i) => ({
    x: MARGIN,
    y: MARGIN + i * (h + GAP),
    w,
    h,
    z: 0,
  }));
}

function arrangeShowAll(count: number, viewW: number, viewH: number): WinState[] {
  if (count === 0) return [];
  const cols = Math.min(count, 3);
  const rows = Math.ceil(count / cols);
  const w = Math.max(MIN_W, Math.floor((viewW - MARGIN * 2 - GAP * (cols - 1)) / cols));
  const h = Math.max(MIN_H, Math.floor((viewH - MARGIN * 2 - GAP * (rows - 1)) / rows));
  return Array.from({ length: count }, (_, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return {
      x: MARGIN + c * (w + GAP),
      y: MARGIN + r * (h + GAP),
      w,
      h,
      z: 0,
    };
  });
}

function arrangeFor(
  mode: LayoutMode,
  count: number,
  viewW: number,
  viewH: number,
): WinState[] {
  switch (mode) {
    case 'tile':
      return arrangeTile(count, viewW, viewH);
    case 'cascade':
      return arrangeCascade(count);
    case 'stack':
      return arrangeStack(count, viewW, viewH);
    case 'show-all':
      return arrangeShowAll(count, viewW, viewH);
  }
}

export function DesktopTab() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [wins, setWins] = useState<Record<string, WinState>>(loadWinState);
  const topZ = useRef<number>(
    Math.max(1, ...Object.values(loadWinState()).map((w) => w.z)),
  );
  const [layout, setLayout] = useState<LayoutMode>('tile');
  const areaRef = useRef<HTMLDivElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const refresh = async (): Promise<void> => {
      try {
        const res = await authedFetch('/api/sessions');
        if (!res.ok) return;
        const list = (await res.json()) as SessionRecord[];
        if (cancelledRef.current) return;
        setSessions(list);
        // Ensure every live session has a win state; assign a cascading
        // default for any new one.
        setWins((prev) => {
          const next = { ...prev };
          let changed = false;
          list.forEach((s, i) => {
            if (!next[s.sessionId]) {
              next[s.sessionId] = cascadeDefault(i);
              topZ.current = Math.max(topZ.current, next[s.sessionId]!.z);
              changed = true;
            }
          });
          if (changed) saveWinState(next);
          return next;
        });
      } catch {
        /* transient */
      }
    };
    void refresh();
    const handle = setInterval(() => void refresh(), 3000);
    return () => {
      cancelledRef.current = true;
      clearInterval(handle);
    };
  }, []);

  const focusWin = (sid: string): void => {
    topZ.current += 1;
    setWins((prev) => {
      const next = { ...prev, [sid]: { ...prev[sid]!, z: topZ.current } };
      saveWinState(next);
      return next;
    });
  };

  const startDrag = (sid: string, evt: React.MouseEvent<HTMLDivElement>): void => {
    // Don't start drag if the click is on an interactive element inside the header.
    const target = evt.target as HTMLElement;
    if (target.closest('button, input, select, textarea, .dwin-dots')) return;
    evt.preventDefault();
    focusWin(sid);
    const w = wins[sid]!;
    const startX = evt.clientX - w.x;
    const startY = evt.clientY - w.y;
    const onMove = (e: MouseEvent): void => {
      const nx = Math.max(0, e.clientX - startX);
      const ny = Math.max(0, e.clientY - startY);
      setWins((prev) => {
        const next = { ...prev, [sid]: { ...prev[sid]!, x: nx, y: ny } };
        return next;
      });
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setWins((prev) => {
        saveWinState(prev);
        return prev;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const startResize = (
    sid: string,
    evt: React.MouseEvent<HTMLDivElement>,
    mode: 'se' | 'e' | 's',
  ): void => {
    evt.preventDefault();
    evt.stopPropagation();
    focusWin(sid);
    const w = wins[sid]!;
    const startX = evt.clientX;
    const startY = evt.clientY;
    const ow = w.w;
    const oh = w.h;
    const onMove = (e: MouseEvent): void => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      setWins((prev) => {
        const cur = prev[sid]!;
        const nw = mode === 's' ? cur.w : Math.max(MIN_W, ow + dx);
        const nh = mode === 'e' ? cur.h : Math.max(MIN_H, oh + dy);
        return { ...prev, [sid]: { ...cur, w: nw, h: nh } };
      });
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setWins((prev) => {
        saveWinState(prev);
        return prev;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const onKillRefresh = (): void => {
    // re-pull session list so dead panes disappear
    setSessions((prev) => prev);
  };

  /** Auto-arrange — overwrite x/y/w/h for every live session, keep z. */
  const applyLayout = (mode: LayoutMode): void => {
    setLayout(mode);
    const area = areaRef.current;
    const viewW = area?.clientWidth ?? 1200;
    const viewH = area?.clientHeight ?? 800;
    const positions = arrangeFor(mode, sessions.length, viewW, viewH);
    setWins((prev) => {
      const next: Record<string, WinState> = { ...prev };
      sessions.forEach((s, i) => {
        const p = positions[i];
        if (!p) return;
        const existing = next[s.sessionId];
        next[s.sessionId] = {
          ...p,
          // Cascade z's bottom-to-top so later windows sit on top;
          // other modes keep whatever z each window already has.
          z: mode === 'cascade' ? 1 + i : existing?.z ?? 1 + i,
        };
      });
      if (mode === 'cascade') {
        topZ.current = sessions.length;
      }
      saveWinState(next);
      return next;
    });
  };

  return (
    <div className="desktop-wrap">
      <div className="desktop-toolbar">
        <LayoutControls mode={layout} onChange={applyLayout} />
        <span className="desktop-toolbar-hint">
          Auto-arrange the {sessions.length} floating window{sessions.length === 1 ? '' : 's'} — you
          can still drag and resize after.
        </span>
      </div>
      <div className="desktop-area" ref={areaRef}>
        {sessions.length === 0 && (
          <div className="desktop-empty">
            No sessions yet. Use Spawn to open a pane — it will appear here as a
            floating window you can drag and resize.
          </div>
        )}
      {sessions.map((s) => {
        const w = wins[s.sessionId];
        if (!w) return null;
        return (
          <div
            key={s.sessionId}
            className="dwin-float"
            style={{
              left: w.x,
              top: w.y,
              width: w.w,
              height: w.h,
              zIndex: w.z,
            }}
            onMouseDown={() => focusWin(s.sessionId)}
          >
            <div className="dwin-float-drag" onMouseDown={(e) => startDrag(s.sessionId, e)}>
              <PaneCard
                session={s}
                peerSessions={sessions}
                onKill={onKillRefresh}
              />
            </div>
            <div
              className="dwin-resize rs"
              onMouseDown={(e) => startResize(s.sessionId, e, 'se')}
              aria-label="Resize window SE"
            />
            <div
              className="dwin-resize re"
              onMouseDown={(e) => startResize(s.sessionId, e, 'e')}
              aria-label="Resize window E"
            />
            <div
              className="dwin-resize rb"
              onMouseDown={(e) => startResize(s.sessionId, e, 's')}
              aria-label="Resize window S"
            />
          </div>
        );
      })}
      </div>
    </div>
  );
}
