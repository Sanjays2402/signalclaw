// Pure helpers for the /stops table deep-link query string.
// Mirrors the shape of watchesUrl + bracketsUrl so /stops stays consistent
// with the other shareable filter surfaces.
//
// Two knobs drive the stops table filter: a free-text ticker substring and
// a kind bucket (stop_loss, take_profit, trailing). Mirroring them lets a
// user copy /stops?q=aapl&kind=trailing to a teammate and land on the same
// filtered view.

export const STOP_KIND_FILTERS = [
  "all",
  "stop_loss",
  "take_profit",
  "trailing",
] as const;

export type StopKindUrl = (typeof STOP_KIND_FILTERS)[number];

export const STOPS_FILTER_DEFAULT: { kind: StopKindUrl } = {
  kind: "all",
};

export type StopsUrlState = {
  // Free-text filter applied client-side against the rule ticker. Empty
  // string means no filter.
  query: string;
  kind: StopKindUrl;
};

function isKind(s: string | null): s is StopKindUrl {
  return s !== null && (STOP_KIND_FILTERS as readonly string[]).includes(s);
}

/**
 * Parse the /stops query string into a normalized filter state. Unknown
 * kind values fall back to "all" so a hand-edited URL never lands the
 * table in a broken state.
 */
export function parseStopsUrlState(
  search: string | URLSearchParams,
): StopsUrlState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const query = (sp.get("q") ?? "").trim().slice(0, 64);
  const rawKind = sp.get("kind");
  const kind = isKind(rawKind) ? rawKind : STOPS_FILTER_DEFAULT.kind;
  return { query, kind };
}

/**
 * Serialize state back to a query string. Defaults are omitted so the bare
 * /stops URL stays clean when nothing has been customized.
 */
export function serializeStopsUrlState(state: StopsUrlState): string {
  const sp = new URLSearchParams();
  const q = (state.query ?? "").trim();
  if (q) sp.set("q", q.slice(0, 64));
  if (state.kind !== STOPS_FILTER_DEFAULT.kind) sp.set("kind", state.kind);
  return sp.toString();
}
