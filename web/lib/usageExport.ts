// Usage page export helpers. Pure, no I/O; used by the /usage
// "Download CSV/JSON" buttons and unit tested in tests/usageExport.test.mjs.
//
// CSV is the daily activity table (one row per day in chronological order)
// with a leading summary comment row carrying the period and quota numbers
// so a billing or capacity spreadsheet has the report-level context without
// an extra round trip. JSON is the full summary plus an exported_at stamp
// so the file is self-describing. CSV cells with a comma, quote, or newline
// are quoted per RFC 4180. Cells starting with =, +, -, @, tab, or carriage
// return are prefixed with a single quote to neutralise spreadsheet formula
// injection, mirroring the journal export hardening.

export type DayBucketLite = { date: string; count: number };
export type TickerBucketLite = { ticker: string; count: number };
export type RegimeBucketLite = { regime: string; count: number };

export type UsageSummaryLite = {
  used: number;
  limit: number;
  remaining: number;
  pct: number;
  over_quota: boolean;
  period_start: string;
  period_end: string;
  resets_at: string;
  days_remaining: number;
  by_day: DayBucketLite[];
  by_ticker: TickerBucketLite[];
  by_regime: RegimeBucketLite[];
  lifetime: number;
};

const FORMULA_LEADERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

function csvCell(v: string): string {
  if (v === "") return "";
  let cell = v;
  if (FORMULA_LEADERS.has(cell.charAt(0))) {
    cell = `'${cell}`;
  }
  if (/[",\r\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return n.toString();
}

function sortedDays(days: DayBucketLite[]): DayBucketLite[] {
  return days.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function usageToCSV(s: UsageSummaryLite): string {
  const lines: string[] = [];
  lines.push("date,count,cumulative,used,limit,remaining,period_start,period_end");
  let cum = 0;
  for (const d of sortedDays(s.by_day ?? [])) {
    cum += Number.isFinite(d.count) ? d.count : 0;
    lines.push(
      [
        csvCell(d.date ?? ""),
        num(d.count),
        num(cum),
        num(s.used),
        num(s.limit),
        num(s.remaining),
        csvCell(s.period_start ?? ""),
        csvCell(s.period_end ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function usageToJSON(s: UsageSummaryLite): string {
  const payload = {
    exported_at: new Date().toISOString(),
    summary: {
      used: s.used,
      limit: s.limit,
      remaining: s.remaining,
      pct: s.pct,
      over_quota: s.over_quota,
      lifetime: s.lifetime,
      period_start: s.period_start,
      period_end: s.period_end,
      resets_at: s.resets_at,
      days_remaining: s.days_remaining,
    },
    by_day: sortedDays(s.by_day ?? []),
    by_ticker: (s.by_ticker ?? []).slice(),
    by_regime: (s.by_regime ?? []).slice(),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function usageFilename(s: UsageSummaryLite, ext: "csv" | "json"): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const period = (s.period_start ?? "").slice(0, 7); // YYYY-MM
  const parts = ["signalclaw-usage"];
  if (/^\d{4}-\d{2}$/.test(period)) parts.push(period);
  parts.push(stamp);
  return `${parts.join("-")}.${ext}`;
}
