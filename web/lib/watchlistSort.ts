// Pure sort helpers for the /watchlist UI. Kept React-free so it can be
// unit tested under node --test.
import { nearestTargetDistance } from "./watchlistDistance.ts";

export type SortKey = "added" | "ticker" | "distance";
export type SortDir = "asc" | "desc";

export type WatchlistEntryLike = {
  ticker: string;
  added_at: string;
  target_high: number | null;
  target_low: number | null;
};

export type CheckRowLike = {
  ticker: string;
  target_high: number | null;
  target_low: number | null;
  last_close: number | null;
};

// Distance percent (absolute value) from last close to the nearest target.
// Returns null when there are no targets, no close, or close already sits
// outside the bracket (no meaningful "distance to" remains).
export function distanceForSort(
  entry: WatchlistEntryLike,
  check: CheckRowLike | undefined,
): number | null {
  if (!check || check.last_close === null || check.last_close === undefined) return null;
  const d = nearestTargetDistance(check.last_close, entry.target_high, entry.target_low);
  if (!d) return null;
  return Math.abs(d.pct);
}

function cmpStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpDates(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  const va = Number.isFinite(ta) ? ta : 0;
  const vb = Number.isFinite(tb) ? tb : 0;
  return va - vb;
}

export function sortEntries<T extends WatchlistEntryLike>(
  entries: T[],
  key: SortKey,
  dir: SortDir,
  checks: Record<string, CheckRowLike> = {},
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const copy = entries.slice();
  copy.sort((a, b) => {
    let primary = 0;
    if (key === "ticker") {
      primary = cmpStrings(a.ticker, b.ticker);
    } else if (key === "added") {
      primary = cmpDates(a.added_at, b.added_at);
    } else if (key === "distance") {
      const da = distanceForSort(a, checks[a.ticker]);
      const db = distanceForSort(b, checks[b.ticker]);
      // Rows with no distance always sink to the bottom, regardless of dir,
      // so an empty watchlist sort never hides rows with real numbers.
      if (da === null && db === null) primary = 0;
      else if (da === null) return 1;
      else if (db === null) return -1;
      else primary = da - db;
    }
    if (primary !== 0) return primary * sign;
    // Stable tiebreaker by ticker so sorts are deterministic.
    return cmpStrings(a.ticker, b.ticker);
  });
  return copy;
}
