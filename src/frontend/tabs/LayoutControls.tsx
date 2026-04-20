/**
 * U6 — layout-mode selector for the pane grid. Ports the v2.x
 * Tile/Cascade/Stack/Show All controls.
 */

export type LayoutMode = 'tile' | 'cascade' | 'stack' | 'show-all';

const MODES: ReadonlyArray<{ id: LayoutMode; label: string; title: string }> = [
  { id: 'tile', label: 'Tile', title: 'Two-column grid (default)' },
  { id: 'cascade', label: 'Cascade', title: 'Horizontal scroll, overlapping cards' },
  { id: 'stack', label: 'Stack', title: 'One card per row, full-width' },
  { id: 'show-all', label: 'Show All', title: 'Dense three-column grid' },
];

export function LayoutControls({
  mode,
  onChange,
}: {
  mode: LayoutMode;
  onChange: (m: LayoutMode) => void;
}) {
  return (
    <div className="layout-controls" role="group" aria-label="Grid layout">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`layout-btn ${mode === m.id ? 'active' : ''}`}
          title={m.title}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
