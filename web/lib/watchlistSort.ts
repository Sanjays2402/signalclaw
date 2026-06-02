// Pure sort helpers for the /watchlist UI. Kept React-free so it can be
// unit tested under node --test.
import { nearestTargetDistance } from "./watchlistDistance.ts";

export type SortKey = "added" | "ticker" | "distance";
export type SortDir = "asc" | "desc";

export const SORT_KEYS: readonly SortKey[] = ["added", "ticker", "distance"];
export const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];
export const SORT_KEY_DEFAULT: SortKey = "added";
export const SORT_DIR_DEFAULT: SortDir = "desc";

export type WatchlistUrlState = {
  /** Free-text filter on ticker or note. Trimmed and capped to keep URLs sane. */
  filter: string;
  sortKey: SortKey;
  sortDir: SortDir;
};

/**
 * Parse the /watchlist deep-link query string into a normalized state.
 * Unknown sort keys or directions fall back to defaults so a hand-edited URL
 * never lands the page in an invalid state.
 */
export function parseWatchlistUrlState(
  search: string | URLSearchParams,
): WatchlistUrlState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const filter = (sp.get("q") ?? "").slice(0, 200);
  const rawKey = sp.get("sort") ?? "";
  const sortKey: SortKey = (SORT_KEYS as readonly string[]).includes(rawKey)
    ? (rawKey as SortKey)
    : SORT_KEY_DEFAULT;
  const rawDir = sp.get("dir") ?? "";
  const sortDir: SortDir = (SORT_DIRS as readonly string[]).includes(rawDir)
    ? (rawDir as SortDir)
    : SORT_DIR_DEFAULT;
  return { filter, sortKey, sortDir };
}

/**
 * Serialize state back to a query string. Defaults are omitted so a fresh
 * /watchlist view stays a clean URL with no parameters.
 */
export function serializeWatchlistUrlState(state: WatchlistUrlState): string {
  const sp = new URLSearchParams();
  if (state.filter) sp.set("q", state.filter);
  if (state.sortKey && state.sortKey !== SORT_KEY_DEFAULT) sp.set("sort", state.sortKey);
  if (state.sortDir && state.sortDir !== SORT_DIR_DEFAULT) sp.set("dir", state.sortDir);
  return sp.toString();
}

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
