// Watches export helpers. Pure, no I/O; used by the /watches
// "Download CSV/JSON" buttons and unit tested in tests/watchesExport.test.mjs.
//
// Rows are sorted by ticker asc then created_at asc so the spreadsheet has a
// stable shape regardless of API order. CSV cells follow RFC 4180 quoting and
// neutralise spreadsheet formula injection on user-supplied fields (label,
// last_error) since those can contain arbitrary text.

export type WatchLite = {
  id: string;
  ticker: string;
  lookback_days: number;
  cadence_hours: number;
  enabled: boolean;
  label: string;
  created_at: string;
  last_run_at: string | null;
  last_run_id: string | null;
  last_regime: string | null;
  last_error: string | null;
  runs_count: number;
};

function csvCell(v: string): string {
  if (v === "") return "";
  const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function sortedWatches(rows: WatchLite[]): WatchLite[] {
  return rows.slice().sort((a, b) => {
    const byTicker = (a.ticker || "").localeCompare(b.ticker || "");
    if (byTicker !== 0) return byTicker;
    const byCreated = (a.created_at || "").localeCompare(b.created_at || "");
    if (byCreated !== 0) return byCreated;
    return (a.id || "").localeCompare(b.id || "");
  });
}

export type WatchFilter = {
  // Free-text substring matched against the watch ticker (case-insensitive).
  ticker?: string;
  // Enabled-state bucket. "all" returns every row, "active" keeps enabled,
  // "paused" keeps disabled.
  state?: "all" | "active" | "paused";
};

export function filterWatches(rows: WatchLite[], f: WatchFilter): WatchLite[] {
  const q = (f.ticker ?? "").trim().toUpperCase();
  const state = f.state ?? "all";
  if (!q && state === "all") return rows.slice();
  return rows.filter((w) => {
    if (q && !(w.ticker ?? "").toUpperCase().includes(q)) return false;
    if (state === "active" && !w.enabled) return false;
    if (state === "paused" && w.enabled) return false;
    return true;
  });
}

export function watchesToCSV(rows: WatchLite[]): string {
  const lines: string[] = [];
  lines.push(
    "ticker,label,cadence_hours,lookback_days,enabled,last_regime,last_run_at,runs_count,last_error,created_at,id",
  );
  for (const r of sortedWatches(rows)) {
    lines.push(
      [
        csvCell(r.ticker ?? ""),
        csvCell(r.label ?? ""),
        String(r.cadence_hours ?? ""),
        String(r.lookback_days ?? ""),
        r.enabled ? "true" : "false",
        csvCell(r.last_regime ?? ""),
        csvCell(r.last_run_at ?? ""),
        String(r.runs_count ?? 0),
        csvCell(r.last_error ?? ""),
        csvCell(r.created_at ?? ""),
        csvCell(r.id ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function watchesToJSON(rows: WatchLite[]): string {
  return JSON.stringify({ watches: sortedWatches(rows) }, null, 2) + "\n";
}

export function watchesFilename(ext: "csv" | "json"): string {
  return `watches.${ext}`;
}
