// News event export helpers. Pure, no I/O; used by the /news "Download
// CSV/JSON" buttons and unit tested in tests/newsExport.test.mjs.
//
// Events are sorted by event_date descending then ticker ascending so the
// spreadsheet view matches the on-page ordering. Tags are joined with `|`
// inside a single CSV cell so the column stays scalar. CSV cells containing
// a comma, quote, or newline are quoted per RFC 4180.

export type NewsEventLite = {
  id: string;
  ticker: string;
  headline: string;
  event_date: string;
  tags: string[];
  source: string;
  url: string;
  created_at?: string;
};

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function sortedEvents(rows: NewsEventLite[]): NewsEventLite[] {
  return rows.slice().sort((a, b) => {
    const byDate = (b.event_date || "").localeCompare(a.event_date || "");
    if (byDate !== 0) return byDate;
    const byTicker = (a.ticker || "").localeCompare(b.ticker || "");
    if (byTicker !== 0) return byTicker;
    return (a.id || "").localeCompare(b.id || "");
  });
}

export function newsEventsToCSV(rows: NewsEventLite[]): string {
  const lines: string[] = [];
  lines.push("event_date,ticker,headline,tags,source,url,id");
  for (const r of sortedEvents(rows)) {
    lines.push(
      [
        csvCell(r.event_date ?? ""),
        csvCell((r.ticker ?? "").toUpperCase()),
        csvCell(r.headline ?? ""),
        csvCell((r.tags ?? []).join("|")),
        csvCell(r.source ?? ""),
        csvCell(r.url ?? ""),
        csvCell(r.id ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function newsEventsToJSON(rows: NewsEventLite[]): string {
  return JSON.stringify({ events: sortedEvents(rows) }, null, 2) + "\n";
}

export function newsFilename(
  ticker: string,
  tag: string,
  ext: "csv" | "json",
): string {
  const parts = ["news"];
  const t = (ticker || "").trim().toUpperCase();
  if (t) parts.push(t);
  const g = (tag || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (g) parts.push(g);
  return `${parts.join("-")}.${ext}`;
}
