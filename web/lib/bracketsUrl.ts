// Pure helpers for the /brackets plan table deep-link query string.
// Mirrors the shape of portfolioUrl + journalUrl so /brackets stays
// consistent with the other shareable filter surfaces.
//
// Two knobs drive the plan table filter: a free-text ticker substring
// and a status bucket. Mirroring them lets a user copy
// /brackets?q=aapl&status=live to a teammate and land on the same view.

export const BRACKET_STATUS_FILTERS = [
  "all",
  "open",
  "filled",
  "live",
  "closed",
  "closed_win",
  "closed_loss",
  "cancelled",
] as const;

export type BracketStatusUrl = (typeof BRACKET_STATUS_FILTERS)[number];

export const BRACKETS_FILTER_DEFAULT: { status: BracketStatusUrl } = {
  status: "all",
};

export type BracketsUrlState = {
  // Free-text filter applied client-side against the plan ticker. Empty
  // string means no filter.
  query: string;
  status: BracketStatusUrl;
};

function isStatus(s: string | null): s is BracketStatusUrl {
  return s !== null && (BRACKET_STATUS_FILTERS as readonly string[]).includes(s);
}

/**
 * Parse the /brackets query string into a normalized filter state. Unknown
 * status values fall back to "all" so a hand-edited URL never lands the
 * table in a broken state.
 */
export function parseBracketsUrlState(
  search: string | URLSearchParams,
): BracketsUrlState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const query = (sp.get("q") ?? "").trim().slice(0, 64);
  const rawStatus = sp.get("status");
  const status = isStatus(rawStatus) ? rawStatus : BRACKETS_FILTER_DEFAULT.status;
  return { query, status };
}

/**
 * Serialize state back to a query string. Defaults are omitted so the bare
 * /brackets URL stays clean when nothing has been customized.
 */
export function serializeBracketsUrlState(state: BracketsUrlState): string {
  const sp = new URLSearchParams();
  const q = (state.query ?? "").trim();
  if (q) sp.set("q", q.slice(0, 64));
  if (state.status !== BRACKETS_FILTER_DEFAULT.status) sp.set("status", state.status);
  return sp.toString();
}
