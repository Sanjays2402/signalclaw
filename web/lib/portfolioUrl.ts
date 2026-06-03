// Pure helpers for the /portfolio positions table deep-link query string.
// Mirrors the shape of watchlistSort + diversificationUrl so the page stays
// consistent with /watchlist, /correlation, /diversification, and /journal
// which already ship shareable URL state.
//
// Two knobs drive the positions table: the sort key and the direction.
// Mirroring them lets a user copy /portfolio?sort=pnl&dir=desc to a teammate
// and land on the same view they were looking at.

export const PORTFOLIO_SORT_KEYS = [
  "ticker",
  "qty",
  "avg",
  "mark",
  "mv",
  "weight",
  "pnl",
  "pct",
  "realized",
] as const;

export type PortfolioSortKey = (typeof PORTFOLIO_SORT_KEYS)[number];
export type PortfolioSortDir = 1 | -1;

export const PORTFOLIO_SORT_DEFAULT: { k: PortfolioSortKey; dir: PortfolioSortDir } = {
  k: "mv",
  dir: -1,
};

export type PortfolioUrlState = {
  sortKey: PortfolioSortKey;
  sortDir: PortfolioSortDir;
  // Free-text filter applied client-side against the position ticker.
  // Empty string means no filter.
  query: string;
};

function isSortKey(s: string | null): s is PortfolioSortKey {
  return s !== null && (PORTFOLIO_SORT_KEYS as readonly string[]).includes(s);
}

function parseDir(raw: string | null): PortfolioSortDir {
  if (raw === "asc" || raw === "1") return 1;
  if (raw === "desc" || raw === "-1") return -1;
  return PORTFOLIO_SORT_DEFAULT.dir;
}

/**
 * Parse the /portfolio query string into a normalized table state. Unknown
 * sort keys or directions fall back to defaults so a hand-edited URL never
 * lands the table in a broken state.
 */
export function parsePortfolioUrlState(
  search: string | URLSearchParams,
): PortfolioUrlState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const rawKey = sp.get("sort");
  const sortKey = isSortKey(rawKey) ? rawKey : PORTFOLIO_SORT_DEFAULT.k;
  const sortDir = parseDir(sp.get("dir"));
  const query = (sp.get("q") ?? "").trim().slice(0, 64);
  return { sortKey, sortDir, query };
}

/**
 * Serialize state back to a query string. Defaults are omitted so the bare
 * /portfolio URL stays clean when nothing has been customized.
 */
export function serializePortfolioUrlState(state: PortfolioUrlState): string {
  const sp = new URLSearchParams();
  if (state.sortKey !== PORTFOLIO_SORT_DEFAULT.k) sp.set("sort", state.sortKey);
  if (state.sortDir !== PORTFOLIO_SORT_DEFAULT.dir) {
    sp.set("dir", state.sortDir === 1 ? "asc" : "desc");
  }
  const q = (state.query ?? "").trim();
  if (q) sp.set("q", q.slice(0, 64));
  return sp.toString();
}
