// Correlation export helpers. Pure, no I/O; used by the /correlation
// "Download CSV/JSON" buttons and unit tested in tests/correlationExport.test.mjs.
//
// CSV layout matches what an analyst pasting into a spreadsheet expects: the
// first column header is empty, the remaining headers are the tickers, and
// each row is labelled with its ticker.

export type CorrelationMatrixLite = {
  tickers: string[];
  matrix: number[][];
  window: number;
};

function csvCell(v: string): string {
  // Quote when the cell contains a comma, quote, or newline. Double internal quotes.
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function fmtCorr(v: number): string {
  if (!Number.isFinite(v)) return "";
  // 4 decimals is enough for downstream analysis without rounding noise.
  return v.toFixed(4);
}

export function correlationToCSV(data: CorrelationMatrixLite): string {
  const tickers = data.tickers ?? [];
  const matrix = data.matrix ?? [];
  const header = ["", ...tickers.map((t) => csvCell(t))].join(",");
  const lines: string[] = [header];
  for (let i = 0; i < tickers.length; i++) {
    const row = matrix[i] ?? [];
    const cells = [csvCell(tickers[i])];
    for (let j = 0; j < tickers.length; j++) {
      const v = row[j];
      cells.push(fmtCorr(typeof v === "number" ? v : NaN));
    }
    lines.push(cells.join(","));
  }
  // Trailing newline so the file ends cleanly when opened in editors.
  return lines.join("\n") + "\n";
}

export function correlationToJSON(data: CorrelationMatrixLite): string {
  return JSON.stringify(
    {
      window: data.window,
      tickers: data.tickers ?? [],
      matrix: data.matrix ?? [],
    },
    null,
    2,
  );
}

export function correlationFilename(window: number, ext: "csv" | "json"): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const w = Number.isFinite(window) ? window : 0;
  return `signalclaw-correlation-w${w}-${stamp}.${ext}`;
}
