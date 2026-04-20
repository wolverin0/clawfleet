import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '@shared/types';
import { authedFetch } from '../auth';
import { PaneCard } from './PaneCard';
import { LayoutControls, type LayoutMode } from './LayoutControls';

/**
 * Desktop tab — direct port of v2.7 `.dwin` floating-window surface.
 *
 * This file mirrors `src/dashboard.html` functions:
 *   dtCreateWin, dtMinWin, dtMaxWin, dtFocus, dtRenderDock,
 *   dtTile, dtCascade, dtStack, dtShowAll
 *
 * Layout math + minimize/maximize semantics + drag-from-header-only +
 * resize-from-edges are all taken from the v2.7 implementation with
 * minimal adjustment for React. localStorage key preserved so Sessions
 * & Desktop tabs stay in sync.
 */

interface WinState {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized?: boolean;
  /** Saved pre-maximize rect so toggling maximize can restore. */
  rx?: number;
  ry?: number;
  rw?: number;
  rh?: number;
  max?: boolean;
}

const STORAGE_KEY = 'theorchestra.desktop.winstate.v1';
const DEFAULT_W = 550;
const DEFAULT_H = 380;
const DRAG_MIN_W = 300;
const DRAG_MIN_H = 200;

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
    x: 20 + index * 30,
    y: 10 + index * 30,
    w: DEFAULT_W,
    h: DEFAULT_H,
    z: 10 + index,
  };
}

export function DesktopTab() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [wins, setWins] = useState<Record<string, WinState>>(loadWinState);
  const topZ = useRef<number>(
    Math.max(10, ...Object.values(loadWinState()).map((w) => w.z)),
  );
  const [layout, setLayout] = useState<LayoutMode>('tile');
  const areaRef = useRef<HTMLDivElement | null>(null);
  const cancelledRef = useRef(false);
  // Always-current snapshots so drag/resize handlers read latest state.
  const winsRef = useRef(wins);
  winsRef.current = wins;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await authedFetch('/api/sessions');
      if (!res.ok) return;
      const list = (await res.json()) as SessionRecord[];
      if (cancelledRef.current) return;
      setSessions(list);
      // Assign a cascading default to any new session; leave existing alone.
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
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    const handle = setInterval(() => void refresh(), 3000);
    return () => {
      cancelledRef.current = true;
      clearInterval(handle);
    };
  }, [refresh]);

  const focusWin = (sid: string): void => {
    topZ.current += 1;
    setWins((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      const next = { ...prev, [sid]: { ...cur, z: topZ.current } };
      saveWinState(next);
      return next;
    });
  };

  /** v2.7 dtMinWin — collapse to dock. */
  const minimizeWin = (sid: string): void => {
    setWins((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      const next = { ...prev, [sid]: { ...cur, minimized: true } };
      saveWinState(next);
      return next;
    });
  };

  /** v2.7 dtMaxWin — toggle maximize, save/restore prior rect. */
  const maximizeWin = (sid: string): void => {
    const area = areaRef.current;
    if (!area) return;
    setWins((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      let n: WinState;
      if (cur.max) {
        n = {
          ...cur,
          x: cur.rx ?? cur.x,
          y: cur.ry ?? cur.y,
          w: cur.rw ?? cur.w,
          h: cur.rh ?? cur.h,
          max: false,
        };
      } else {
        n = {
          ...cur,
          rx: cur.x,
          ry: cur.y,
          rw: cur.w,
          rh: cur.h,
          x: 0,
          y: 0,
          w: area.offsetWidth,
          h: area.offsetHeight,
          max: true,
          z: topZ.current + 1,
        };
        topZ.current += 1;
      }
      const next = { ...prev, [sid]: n };
      saveWinState(next);
      return next;
    });
  };

  /** v2.7 restoreWindow — un-minimize + focus. */
  const restoreWin = (sid: string): void => {
    setWins((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      topZ.current += 1;
      const next = { ...prev, [sid]: { ...cur, minimized: false, z: topZ.current } };
      saveWinState(next);
      return next;
    });
  };

  const handleKillResult = useCallback((): void => {
    void refresh();
  }, [refresh]);

  const startDrag = (sid: string, evt: React.MouseEvent): void => {
    evt.preventDefault();
    evt.stopPropagation();
    focusWin(sid);
    const w0 = winsRef.current[sid]!;
    const sx = evt.clientX - w0.x;
    const sy = evt.clientY - w0.y;
    const onMove = (e: MouseEvent): void => {
      const nx = Math.max(0, e.clientX - sx);
      const ny = Math.max(0, e.clientY - sy);
      setWins((prev) => ({ ...prev, [sid]: { ...prev[sid]!, x: nx, y: ny } }));
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
    evt: React.MouseEvent,
    mode: 'se' | 'e' | 's',
  ): void => {
    evt.preventDefault();
    evt.stopPropagation();
    focusWin(sid);
    const w0 = winsRef.current[sid]!;
    const sx = evt.clientX;
    const sy = evt.clientY;
    const ow = w0.w;
    const oh = w0.h;
    const onMove = (e: MouseEvent): void => {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      setWins((prev) => {
        const cur = prev[sid]!;
        const nw = mode === 's' ? cur.w : Math.max(DRAG_MIN_W, ow + dx);
        const nh = mode === 'e' ? cur.h : Math.max(DRAG_MIN_H, oh + dy);
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

  /** Visible (non-minimized) session ids — used by all arrangers. */
  const visibleIds = (): string[] =>
    sessions.filter((s) => !wins[s.sessionId]?.minimized).map((s) => s.sessionId);

  /** v2.7 dtTile (lines 2096-2108) — cols = ceil(sqrt(n)), cell = (aw/cols) - 6. */
  const dtTile = (): void => {
    const area = areaRef.current;
    if (!area) return;
    const aw = area.offsetWidth;
    const ah = area.offsetHeight;
    const vis = visibleIds();
    if (!vis.length) return;
    const cols = Math.ceil(Math.sqrt(vis.length));
    const rows = Math.ceil(vis.length / cols);
    const ww = Math.floor(aw / cols) - 6;
    const wh = Math.floor(ah / rows) - 6;
    setWins((prev) => {
      const next = { ...prev };
      vis.forEach((sid, i) => {
        const cur = next[sid];
        if (!cur) return;
        next[sid] = {
          ...cur,
          x: 3 + (i % cols) * (ww + 6),
          y: 3 + Math.floor(i / cols) * (wh + 6),
          w: ww,
          h: wh,
          max: false,
        };
      });
      saveWinState(next);
      return next;
    });
  };

  /** v2.7 dtCascade (lines 2110-2118) — 20+i*30 x, 10+i*30 y, 550x380. */
  const dtCascade = (): void => {
    const vis = visibleIds();
    setWins((prev) => {
      const next = { ...prev };
      vis.forEach((sid, i) => {
        const cur = next[sid];
        if (!cur) return;
        next[sid] = {
          ...cur,
          x: 20 + i * 30,
          y: 10 + i * 30,
          w: 550,
          h: 380,
          z: 10 + i,
          max: false,
        };
      });
      saveWinState(next);
      return next;
    });
    topZ.current = 10 + vis.length;
  };

  /** v2.7 dtStack (lines 2120-2131) — one centered 650x450 window, stacked by z. */
  const dtStack = (): void => {
    const area = areaRef.current;
    if (!area) return;
    const aw = area.offsetWidth;
    const ah = area.offsetHeight;
    const vis = visibleIds();
    const ww = Math.min(650, aw - 30);
    const wh = Math.min(450, ah - 30);
    setWins((prev) => {
      const next = { ...prev };
      vis.forEach((sid, i) => {
        const cur = next[sid];
        if (!cur) return;
        next[sid] = {
          ...cur,
          x: (aw - ww) / 2,
          y: (ah - wh) / 2,
          w: ww,
          h: wh,
          z: 10 + i,
          max: false,
        };
      });
      saveWinState(next);
      return next;
    });
    topZ.current = 10 + vis.length;
  };

  /** v2.7 dtShowAll — restore every minimized window; don't move. */
  const dtShowAll = (): void => {
    setWins((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((sid) => {
        if (next[sid]!.minimized) next[sid] = { ...next[sid]!, minimized: false };
      });
      saveWinState(next);
      return next;
    });
  };

  const applyLayout = (mode: LayoutMode): void => {
    setLayout(mode);
    if (mode === 'tile') dtTile();
    else if (mode === 'cascade') dtCascade();
    else if (mode === 'stack') dtStack();
    else if (mode === 'show-all') dtShowAll();
  };

  return (
    <div className="desktop-wrap">
      <div className="desktop-toolbar">
        <LayoutControls mode={layout} onChange={applyLayout} />
        <span className="desktop-toolbar-hint">
          {sessions.length} pane{sessions.length === 1 ? '' : 's'} — drag by the
          header, resize from corner/edges, ● minimizes / ● minimizes / ● maximizes.
        </span>
      </div>
      <div className="desktop-area" ref={areaRef}>
        {sessions.length === 0 && (
          <div className="desktop-empty">
            No sessions yet. Use Spawn to open a pane.
          </div>
        )}
        {sessions.map((s) => {
          const w = wins[s.sessionId];
          if (!w || w.minimized) return null;
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
              onMouseDown={(e) => {
                // v2.7 parity: focus any window you click inside. Drag is
                // ONLY when mousedown hits the `.dwin-header` region (below).
                const t = e.target as HTMLElement;
                if (t.closest('.dwin-resize')) return; // resize handles handle their own
                focusWin(s.sessionId);
                const inHeader = t.closest('.dwin-header');
                const inInteractive = t.closest(
                  'button, input, select, textarea, .dwin-dots',
                );
                if (inHeader && !inInteractive) {
                  startDrag(s.sessionId, e);
                }
              }}
            >
              <PaneCard
                session={s}
                peerSessions={sessions}
                onKill={handleKillResult}
                onMinimize={() => minimizeWin(s.sessionId)}
                onMaximize={() => maximizeWin(s.sessionId)}
              />
              <div
                className="dwin-resize rs"
                onMouseDown={(e) => startResize(s.sessionId, e, 'se')}
                aria-label="Resize SE"
              />
              <div
                className="dwin-resize re"
                onMouseDown={(e) => startResize(s.sessionId, e, 'e')}
                aria-label="Resize E"
              />
              <div
                className="dwin-resize rb"
                onMouseDown={(e) => startResize(s.sessionId, e, 's')}
                aria-label="Resize S"
              />
            </div>
          );
        })}
      </div>
      {/* Minimized dock */}
      {sessions.some((s) => wins[s.sessionId]?.minimized) && (
        <div className="desktop-dock">
          {sessions
            .filter((s) => wins[s.sessionId]?.minimized)
            .map((s) => {
              const name = s.tabTitle || s.sessionId.slice(0, 8);
              const initials = (name || 'P').slice(0, 2).toUpperCase();
              return (
                <div
                  key={s.sessionId}
                  className="desktop-dock-item"
                  title={`${name} — click to restore`}
                  onClick={() => restoreWin(s.sessionId)}
                >
                  {initials}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
