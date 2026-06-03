// Stops export helpers. Pure, no I/O; used by the /stops "Download CSV/JSON"
// buttons and unit tested in tests/stopsExport.test.mjs.
//
// Active rules are sorted by ticker ascending then kind so a spreadsheet view
// groups every rule for one symbol together. CSV escapes any field that
// contains a comma, quote, or newline. JSON mirrors the API payload so a
// script can round-trip the full rule set.

export type StopRuleLite = {
  id: string;
  ticker: string;
  kind: string;
  value: number;
  high_water?: number | null;
  armed_at: string;
  note: string;
};

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return n.toString();
}

function sortedRules(rows: StopRuleLite[]): StopRuleLite[] {
  return rows.slice().sort((a, b) => {
    const byTicker = (a.ticker || "").localeCompare(b.ticker || "");
    if (byTicker !== 0) return byTicker;
    const byKind = (a.kind || "").localeCompare(b.kind || "");
    if (byKind !== 0) return byKind;
    return (a.id || "").localeCompare(b.id || "");
  });
}

export function stopsToCSV(rows: StopRuleLite[]): string {
  const lines: string[] = [];
  lines.push("ticker,kind,value,high_water,armed_at,note,id");
  for (const r of sortedRules(rows)) {
    lines.push(
      [
        csvCell(r.ticker ?? ""),
        csvCell(r.kind ?? ""),
        num(r.value),
        num(r.high_water ?? null),
        csvCell(r.armed_at ?? ""),
        csvCell(r.note ?? ""),
        csvCell(r.id ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function stopsToJSON(rows: StopRuleLite[]): string {
  const payload = {
    exported_at: new Date().toISOString(),
    count: rows.length,
    rules: sortedRules(rows),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function stopsFilename(ext: "csv" | "json"): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `signalclaw-stops-${stamp}.${ext}`;
}
