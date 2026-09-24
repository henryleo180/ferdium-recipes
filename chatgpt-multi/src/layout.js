'use strict';

// Where each account's page sits in the window. Pure geometry so it can be
// unit tested; the tab strip page reads the same numbers from the state it
// receives, so the CSS never has to repeat them.

const METRICS = Object.freeze({
  toolbarHeight: 44,
  // Split view: every page gets a frame with a name header, a thin border
  // and a gap around it. The header height includes the frame's top border.
  paneHeader: 28,
  paneBorder: 2,
  paneGap: 6,
});

function grid(count) {
  const cols = count <= 3 ? count : Math.ceil(count / 2);
  return { cols, rows: Math.ceil(count / cols) };
}

// Splits `total` pixels into `parts` whole-pixel segments with `gap` between them.
function segments(total, parts, gap) {
  const usable = Math.max(0, total - gap * (parts - 1));
  return Array.from({ length: parts }, (_, index) => {
    const start = Math.round((usable * index) / parts);
    const end = Math.round((usable * (index + 1)) / parts);
    // Without room for the gaps every segment is empty; keep them in bounds.
    return {
      start: Math.min(start + gap * index, Math.max(0, total)),
      size: end - start,
    };
  });
}

// Shrinks a rectangle; the result always stays inside the original.
function inset(rect, left, top, right, bottom) {
  return {
    x: rect.x + Math.min(left, rect.width),
    y: rect.y + Math.min(top, rect.height),
    width: Math.max(0, rect.width - left - right),
    height: Math.max(0, rect.height - top - bottom),
  };
}

// Returns the visible panes: `frame` is the area the tab strip page decorates,
// `view` is where the account's page goes. Hidden accounts are left out.
function computeLayout({ width, height, ids, activeId, split }) {
  const area = inset(
    { x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) },
    0,
    METRICS.toolbarHeight,
    0,
    0,
  );
  if (!split || ids.length < 2) {
    return ids.includes(activeId)
      ? [{ id: activeId, frame: area, view: area }]
      : [];
  }
  const { paneGap: gap, paneBorder: border, paneHeader: header } = METRICS;
  const inner = inset(area, gap, gap, gap, gap);
  const { cols, rows } = grid(ids.length);
  const columns = segments(inner.width, cols, gap);
  const lines = segments(inner.height, rows, gap);
  return ids.map((id, index) => {
    const column = columns[index % cols];
    const line = lines[Math.floor(index / cols)];
    const frame = {
      x: inner.x + column.start,
      y: inner.y + line.start,
      width: column.size,
      height: line.size,
    };
    return { id, frame, view: inset(frame, border, header, border, border) };
  });
}

module.exports = { METRICS, computeLayout };
