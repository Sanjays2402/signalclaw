// Pure helpers for the /watches table deep-link query string.
// Mirrors the shape of bracketsUrl + portfolioUrl so /watches stays
// consistent with the other shareable filter surfaces.
//
// Two knobs drive the watches table filter: a free-text ticker substring
// and an enabled-state bucket. Mirroring them lets a user copy
// /watches?q=spy&state=active to a teammate and land on the same view.

export const WATCH_STATE_FILTERS = ["all", "active", "paused"] as const;

export type WatchStateUrl = (typeof WATCH_STATE_FILTERS)[number];

export const WATCHES_FILTER_DEFAULT: { state: WatchStateUrl } = {
  state: "all",
};

export type WatchesUrlState = {
  // Free-text filter applied client-side against the watch ticker. Empty
  // string means no filter.
  query: string;
  state: WatchStateUrl;
};

function isState(s: string | null): s is WatchStateUrl {
  return s !== null && (WATCH_STATE_FILTERS as readonly string[]).includes(s);
}

/**
 * Parse the /watches query string into a normalized filter state. Unknown
 * state values fall back to "all" so a hand-edited URL never lands the
 * table in a broken state.
 */
export function parseWatchesUrlState(
  search: string | URLSearchParams,
): WatchesUrlState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const query = (sp.get("q") ?? "").trim().slice(0, 64);
  const rawState = sp.get("state");
  const state = isState(rawState) ? rawState : WATCHES_FILTER_DEFAULT.state;
  return { query, state };
}

/**
 * Serialize state back to a query string. Defaults are omitted so the bare
 * /watches URL stays clean when nothing has been customized.
 */
export function serializeWatchesUrlState(state: WatchesUrlState): string {
  const sp = new URLSearchParams();
  const q = (state.query ?? "").trim();
  if (q) sp.set("q", q.slice(0, 64));
  if (state.state !== WATCHES_FILTER_DEFAULT.state) sp.set("state", state.state);
  return sp.toString();
}
