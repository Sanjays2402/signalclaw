// Pure helpers for the /tax page deep-link query string.
// Mirrors the shape of bracketsUrl + portfolioUrl so /tax stays consistent
// with the other shareable filter surfaces.
//
// One knob drives both the realized events table and the wash sales list:
// a free-text ticker substring. Mirroring it lets a user copy
// /tax?q=aapl to a teammate and land on the same filtered view.

export type TaxUrlState = {
  // Free-text filter applied client-side against the event/wash sale ticker.
  // Empty string means no filter.
  query: string;
};

export const TAX_FILTER_DEFAULT: TaxUrlState = { query: "" };

/**
 * Parse the /tax query string into a normalized filter state.
 */
export function parseTaxUrlState(
  search: string | URLSearchParams,
): TaxUrlState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const query = (sp.get("q") ?? "").trim().slice(0, 64);
  return { query };
}

/**
 * Serialize state back to a query string. Defaults are omitted so the bare
 * /tax URL stays clean when nothing has been customized.
 */
export function serializeTaxUrlState(state: TaxUrlState): string {
  const sp = new URLSearchParams();
  const q = (state.query ?? "").trim();
  if (q) sp.set("q", q.slice(0, 64));
  return sp.toString();
}

/**
 * Return true if a ticker matches the filter query. Case-insensitive
 * substring match. An empty query matches everything.
 */
export function tickerMatchesTaxQuery(ticker: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return ticker.toLowerCase().includes(q);
}
