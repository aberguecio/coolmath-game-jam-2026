// Shared CSV download machinery. SRP: this module knows ONLY how to escape
// cells, build a CSV string, and trigger a browser download. It does NOT
// know about events, market data, or any specific export shape.
//
// Used by:
//   - Game.js exportEventsCSV (Sprint D Events history export)
//   - Game.js exportMarketHistoryCSV (market state debug export)
// Future CSVs slot in here for free — one util, one download path.

// Quote cells that contain comma, quote, or newline; double internal quotes.
// null/undefined become empty strings so the column count stays stable.
export function escapeCSVCell(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

// Build a CSV string from a headers array + 2D rows array. Each row is an
// array of cells in the same order as headers. Cells get escaped one-by-one.
export function buildCSV(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(row.map(escapeCSVCell).join(','));
  return lines.join('\n');
}

// Trigger a browser download of the given (headers, rows) as `filename`.
//
// Why `application/octet-stream` instead of `text/csv`: when the click
// originates from a Phaser canvas pointer event (not a native HTML button
// click), Chrome sometimes treats the Blob URL as navigatable content and
// opens it inline at `blob:http://...` instead of honoring the `download`
// attribute. Forcing octet-stream makes the response un-renderable so the
// browser falls back to downloading. The filename's `.csv` extension still
// makes Excel/Numbers/pandas open it correctly.
//
// Extra robustness:
//  - UTF-8 BOM at the start so Excel respects accented characters.
//  - `rel="noopener"` to prevent any cross-window leakage.
//  - URL revoked after a microtask so the click has time to consume it.
export function downloadCSV(filename, headers, rows) {
  const body = buildCSV(headers, rows);
  const BOM = '﻿';
  const blob = new Blob([BOM + body], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Cleanup on the next tick so we don't yank the URL out from under the
  // browser before it kicks off the download.
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
