// Execution simulator export helpers. Pure, no I/O; used by the /execution
// "Download CSV/JSON" buttons and unit tested in tests/executionExport.test.mjs.
//
// The CSV mirrors the on-screen fills table (one row per bar fill, in the
// same chronological order the simulator returned), with a leading summary
// comment row so a TCA spreadsheet has the report-level numbers without an
// extra round trip. The JSON is the full ExecReport plus an exported_at
// timestamp so the file is self-describing. CSV cells with a comma, quote,
// or newline are quoted per RFC 4180; ticker is uppercased to match the
// canonical wire form.

export type ExecFillLite = {
  bar_index: number;
  shares: number;
  fill_price: number;
  market_price: number;
  participation: number;
  slippage_bps: number;
  commission: number;
};

export type ExecReportLite = {
  ticker: string;
  side: string;
  requested_shares: number;
  filled_shares: number;
  unfilled_shares: number;
  arrival_price: number;
  avg_fill_price: number;
  interval_vwap: number;
  notional: number;
  commission_total: number;
  slippage_vs_arrival_bps: number;
  slippage_vs_vwap_bps: number;
  fills: ExecFillLite[];
};

function csvCell(v: string): string {
  if (v === "") return "";
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function num(n: number | null | undefined, digits?: number): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (digits == null) return n.toString();
  return n.toFixed(digits);
}

function sortedFills(fills: ExecFillLite[]): ExecFillLite[] {
  return fills.slice().sort((a, b) => {
    const byBar = (a.bar_index ?? 0) - (b.bar_index ?? 0);
    if (byBar !== 0) return byBar;
    // Stable tiebreaker if two fills land on the same bar.
    return 0;
  });
}

export function executionToCSV(r: ExecReportLite): string {
  const ticker = (r.ticker ?? "").toUpperCase();
  const side = r.side ?? "";
  const lines: string[] = [];
  // RFC 4180 header for the fills table. Summary numbers ride along on every
  // row so a spreadsheet pivot keeps the order context per fill.
  lines.push(
    "ticker,side,bar_index,shares,fill_price,market_price,participation_pct,slippage_bps,commission,arrival_price,avg_fill_price,interval_vwap,slippage_vs_arrival_bps,slippage_vs_vwap_bps",
  );
  for (const f of sortedFills(r.fills ?? [])) {
    const part = Number.isFinite(f.participation) ? f.participation * 100 : null;
    lines.push(
      [
        csvCell(ticker),
        csvCell(side),
        num(f.bar_index),
        num(f.shares),
        num(f.fill_price, 4),
        num(f.market_price, 4),
        num(part, 2),
        num(f.slippage_bps, 2),
        num(f.commission, 4),
        num(r.arrival_price, 4),
        num(r.avg_fill_price, 4),
        num(r.interval_vwap, 4),
        num(r.slippage_vs_arrival_bps, 2),
        num(r.slippage_vs_vwap_bps, 2),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function executionToJSON(r: ExecReportLite): string {
  const payload = {
    exported_at: new Date().toISOString(),
    report: {
      ...r,
      ticker: (r.ticker ?? "").toUpperCase(),
      fills: sortedFills(r.fills ?? []),
    },
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function executionFilename(
  ticker: string,
  side: string,
  ext: "csv" | "json",
): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const t = (ticker || "").trim().toUpperCase().replace(/[^A-Z0-9._-]+/g, "");
  const s = (side || "").trim().toLowerCase().replace(/[^a-z]+/g, "");
  const parts = ["signalclaw-execution"];
  if (t) parts.push(t);
  if (s) parts.push(s);
  parts.push(stamp);
  return `${parts.join("-")}.${ext}`;
}
