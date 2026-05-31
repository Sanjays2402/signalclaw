// Pure quota math, no I/O. Kept separate from quota.ts so unit tests can import
// without dragging in the runStore module (which uses extensionless TS imports
// that Node's native --experimental-strip-types loader cannot resolve).
import type { SavedRun } from "./runStore";

export const FREE_TIER_LIMIT = (() => {
  const raw = typeof process !== "undefined" ? process.env.SIGNALCLAW_FREE_TIER_LIMIT : undefined;
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
})();

export type DayBucket = { date: string; count: number };

export type UsageSummary = {
  used: number;
  limit: number;
  remaining: number;
  pct: number;
  over_quota: boolean;
  period_start: string;
  period_end: string;
  resets_at: string;
  days_remaining: number;
  by_day: DayBucket[];
  by_ticker: { ticker: string; count: number }[];
  by_regime: { regime: string; count: number }[];
  lifetime: number;
};

function startOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonthsUTC(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function ymdUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function summarizeUsage(
  runs: SavedRun[],
  now: Date = new Date(),
  limit: number = FREE_TIER_LIMIT,
): UsageSummary {
  const periodStart = startOfMonthUTC(now);
  const periodEnd = addMonthsUTC(periodStart, 1);
  const inPeriod = runs.filter((r) => {
    const t = new Date(r.created_at);
    return t >= periodStart && t < periodEnd;
  });

  const used = inPeriod.length;
  const remaining = Math.max(limit - used, 0);
  const pct = limit > 0 ? Math.min(used / limit, 1) : 0;

  const dayMap = new Map<string, number>();
  const daysInMonth = new Date(
    Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), 0),
  ).getUTCDate();
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), i));
    dayMap.set(ymdUTC(d), 0);
  }
  for (const r of inPeriod) {
    const k = ymdUTC(new Date(r.created_at));
    if (dayMap.has(k)) dayMap.set(k, (dayMap.get(k) ?? 0) + 1);
  }
  const by_day: DayBucket[] = [...dayMap.entries()].map(([date, count]) => ({ date, count }));

  const tickerCounts = new Map<string, number>();
  const regimeCounts = new Map<string, number>();
  for (const r of inPeriod) {
    const t = r.ticker.toUpperCase();
    tickerCounts.set(t, (tickerCounts.get(t) ?? 0) + 1);
    const reg = r.payload.snapshot?.label ?? "unknown";
    regimeCounts.set(reg, (regimeCounts.get(reg) ?? 0) + 1);
  }
  const by_ticker = [...tickerCounts.entries()]
    .map(([ticker, count]) => ({ ticker, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const by_regime = [...regimeCounts.entries()]
    .map(([regime, count]) => ({ regime, count }))
    .sort((a, b) => b.count - a.count);

  const msPerDay = 86_400_000;
  const days_remaining = Math.max(
    0,
    Math.ceil((periodEnd.getTime() - now.getTime()) / msPerDay),
  );

  return {
    used,
    limit,
    remaining,
    pct,
    over_quota: used >= limit,
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    resets_at: periodEnd.toISOString(),
    days_remaining,
    by_day,
    by_ticker,
    by_regime,
    lifetime: runs.length,
  };
}
