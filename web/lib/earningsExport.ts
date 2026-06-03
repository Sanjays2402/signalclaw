// Earnings export helpers. Pure, no I/O; used by the /earnings "Download
// CSV/JSON" buttons and unit tested in tests/earningsExport.test.mjs.
//
// Rows are sorted by next_report ascending so the spreadsheet view matches the
// on-page ordering. The CSV escapes any field that contains a comma, quote, or
// newline; JSON mirrors the raw API payload so a script can round-trip it.

export type EarningsRowLite = {
  ticker: string;
  next_report: string;
  confirmed: boolean;
  source: string;
};

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function sortedRows(rows: EarningsRowLite[]): EarningsRowLite[] {
  return rows.slice().sort((a, b) => {
    const byDate = (a.next_report || "").localeCompare(b.next_report || "");
    if (byDate !== 0) return byDate;
    return (a.ticker || "").localeCompare(b.ticker || "");
  });
}

export function earningsToCSV(rows: EarningsRowLite[]): string {
  const lines: string[] = [];
  lines.push("ticker,next_report,confirmed,source");
  for (const r of sortedRows(rows)) {
    lines.push(
      [
        csvCell(r.ticker ?? ""),
        csvCell(r.next_report ?? ""),
        r.confirmed ? "true" : "false",
        csvCell(r.source ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function earningsToJSON(rows: EarningsRowLite[]): string {
  return JSON.stringify(
    {
      rows: sortedRows(rows).map((r) => ({
        ticker: r.ticker,
        next_report: r.next_report,
        confirmed: !!r.confirmed,
        source: r.source ?? "",
      })),
    },
    null,
    2,
  );
}

export function earningsFilename(within: number | null, ext: "csv" | "json"): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const w = within == null ? "all" : `${within}d`;
  return `signalclaw-earnings-${w}-${stamp}.${ext}`;
}
