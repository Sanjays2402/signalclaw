// Brackets export helpers. Pure, no I/O; used by the /brackets
// "Download CSV/JSON" buttons and unit tested in tests/bracketsExport.test.mjs.
//
// Plans are sorted by status group (open, filled, then closed/cancelled),
// then by ticker ascending, then by created_at ascending so a spreadsheet view
// keeps live work at the top. CSV escapes any field that contains a comma,
// quote, or newline. JSON mirrors the API payload so a script can round-trip
// the full plan set.

export type BracketLite = {
  id: string;
  ticker: string;
  side: string;
  entry: number;
  stop: number;
  target: number;
  shares: number;
  status: string;
  note: string;
  created_at: string;
  actual_entry?: number | null;
  actual_exit?: number | null;
  exit_reason?: string | null;
  planned_r_multiple: number;
  planned_risk_dollars: number;
  realized_r?: number | null;
  realized_pnl?: number | null;
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

function statusRank(s: string): number {
  if (s === "open") return 0;
  if (s === "filled") return 1;
  if (s === "closed_win" || s === "closed_loss") return 2;
  if (s === "cancelled") return 3;
  return 4;
}

function sortedPlans(rows: BracketLite[]): BracketLite[] {
  return rows.slice().sort((a, b) => {
    const byStatus = statusRank(a.status) - statusRank(b.status);
    if (byStatus !== 0) return byStatus;
    const byTicker = (a.ticker || "").localeCompare(b.ticker || "");
    if (byTicker !== 0) return byTicker;
    const byCreated = (a.created_at || "").localeCompare(b.created_at || "");
    if (byCreated !== 0) return byCreated;
    return (a.id || "").localeCompare(b.id || "");
  });
}

export type BracketStatusFilter =
  | "all"
  | "open"
  | "filled"
  | "live"
  | "closed"
  | "closed_win"
  | "closed_loss"
  | "cancelled";

export type BracketFilter = {
  ticker?: string;
  status?: BracketStatusFilter;
};

function matchStatus(plan: BracketLite, status: BracketStatusFilter): boolean {
  if (status === "all") return true;
  if (status === "live") return plan.status === "open" || plan.status === "filled";
  if (status === "closed") return plan.status === "closed_win" || plan.status === "closed_loss";
  return plan.status === status;
}

export function filterPlans(rows: BracketLite[], f: BracketFilter): BracketLite[] {
  const q = (f.ticker ?? "").trim().toUpperCase();
  const status = f.status ?? "all";
  if (!q && status === "all") return rows.slice();
  return rows.filter((p) => {
    if (q && !(p.ticker ?? "").toUpperCase().includes(q)) return false;
    if (!matchStatus(p, status)) return false;
    return true;
  });
}

export function bracketsToCSV(rows: BracketLite[]): string {
  const lines: string[] = [];
  lines.push(
    "ticker,side,shares,entry,stop,target,planned_r,planned_risk_usd,status,actual_entry,actual_exit,exit_reason,realized_r,realized_pnl_usd,created_at,note,id",
  );
  for (const r of sortedPlans(rows)) {
    lines.push(
      [
        csvCell(r.ticker ?? ""),
        csvCell(r.side ?? ""),
        num(r.shares),
        num(r.entry),
        num(r.stop),
        num(r.target),
        num(r.planned_r_multiple),
        num(r.planned_risk_dollars),
        csvCell(r.status ?? ""),
        num(r.actual_entry ?? null),
        num(r.actual_exit ?? null),
        csvCell(r.exit_reason ?? ""),
        num(r.realized_r ?? null),
        num(r.realized_pnl ?? null),
        csvCell(r.created_at ?? ""),
        csvCell(r.note ?? ""),
        csvCell(r.id ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function bracketsToJSON(rows: BracketLite[]): string {
  const payload = {
    exported_at: new Date().toISOString(),
    count: rows.length,
    plans: sortedPlans(rows),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function bracketsFilename(ext: "csv" | "json"): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `signalclaw-brackets-${stamp}.${ext}`;
}
