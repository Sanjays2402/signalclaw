// Pure helpers for the /earnings page deep-link query string.
// Mirrors the shape of taxUrl + bracketsUrl + portfolioUrl so /earnings stays
// consistent with the other shareable filter surfaces.
//
// Two knobs drive the view:
//   - `q`      free-text ticker substring applied client-side.
//   - `within` the day-window selector (7, 14, 30, or all).
// Mirroring both lets a user copy /earnings?q=aapl&within=14 to a teammate and
// land on the same filtered view.

export type EarningsUrlState = {
  // Free-text filter applied client-side against the row ticker.
  // Empty string means no filter.
  query: string;
  // Day window in days, or null for "all".
  within: number | null;
};

export const EARNINGS_WITHIN_CHOICES: ReadonlyArray<number | null> = [
  null,
  7,
  14,
  30,
];

export const EARNINGS_FILTER_DEFAULT: EarningsUrlState = {
  query: "",
  within: null,
};

function normaliseWithin(raw: string | null): number | null {
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  // Snap to the supported choices so an arbitrary ?within=999 falls back
  // to "all" rather than rendering a stale custom value.
  for (const c of EARNINGS_WITHIN_CHOICES) {
    if (c === n) return c;
  }
  return null;
}

/**
 * Parse the /earnings query string into a normalized filter state.
 */
export function parseEarningsUrlState(
  search: string | URLSearchParams,
): EarningsUrlState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const query = (sp.get("q") ?? "").trim().slice(0, 64);
  const within = normaliseWithin(sp.get("within"));
  return { query, within };
}

/**
 * Serialize state back to a query string. Defaults are omitted so the bare
 * /earnings URL stays clean when nothing has been customized.
 */
export function serializeEarningsUrlState(state: EarningsUrlState): string {
  const sp = new URLSearchParams();
  const q = (state.query ?? "").trim();
  if (q) sp.set("q", q.slice(0, 64));
  if (state.within != null) sp.set("within", String(state.within));
  return sp.toString();
}

/**
 * Return true if a ticker matches the filter query. Case-insensitive
 * substring match. An empty query matches everything.
 */
export function tickerMatchesEarningsQuery(
  ticker: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (ticker ?? "").toLowerCase().includes(q);
}
