// Pure helpers for the /diversification deep-link query string. Mirrors the
// shape of correlationUrl.ts so the page stays consistent with /correlation,
// /watchlist, and /journal which already ship shareable URL state.
//
// Two knobs drive the page: the rolling window in bars and the cluster
// threshold. Mirroring them lets users copy /diversification?window=120 to
// a teammate and land on the exact same view.

export const DIV_WINDOW_DEFAULT = 60;
export const DIV_WINDOW_MIN = 10;
export const DIV_WINDOW_MAX = 500;

export const DIV_THRESHOLD_DEFAULT = 0.7;
export const DIV_THRESHOLD_MIN = 0;
export const DIV_THRESHOLD_MAX = 1;

export type DiversificationUrlState = {
  window: number;
  threshold: number;
};

function clampWindow(n: number): number {
  if (!Number.isFinite(n)) return DIV_WINDOW_DEFAULT;
  const i = Math.trunc(n);
  if (i < DIV_WINDOW_MIN) return DIV_WINDOW_MIN;
  if (i > DIV_WINDOW_MAX) return DIV_WINDOW_MAX;
  return i;
}

function clampThreshold(n: number): number {
  if (!Number.isFinite(n)) return DIV_THRESHOLD_DEFAULT;
  if (n < DIV_THRESHOLD_MIN) return DIV_THRESHOLD_MIN;
  if (n > DIV_THRESHOLD_MAX) return DIV_THRESHOLD_MAX;
  // Two-decimal rounding keeps the URL short and stable across small edits.
  return Math.round(n * 100) / 100;
}

/**
 * Parse the /diversification query string into a normalized state. Out-of-
 * range or unparseable values fall back to defaults so a hand-edited URL
 * never lands the page in a broken state.
 */
export function parseDiversificationUrlState(
  search: string | URLSearchParams,
): DiversificationUrlState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const rawWindow = sp.get("window");
  const rawThreshold = sp.get("threshold");
  const window = rawWindow === null || rawWindow === ""
    ? DIV_WINDOW_DEFAULT
    : clampWindow(Number(rawWindow));
  const threshold = rawThreshold === null || rawThreshold === ""
    ? DIV_THRESHOLD_DEFAULT
    : clampThreshold(Number(rawThreshold));
  return { window, threshold };
}

/**
 * Serialize state back to a query string. Defaults are omitted so the bare
 * /diversification URL stays clean when nothing has been customized.
 */
export function serializeDiversificationUrlState(state: DiversificationUrlState): string {
  const sp = new URLSearchParams();
  const w = clampWindow(state.window);
  const t = clampThreshold(state.threshold);
  if (w !== DIV_WINDOW_DEFAULT) sp.set("window", String(w));
  if (t !== DIV_THRESHOLD_DEFAULT) sp.set("threshold", String(t));
  return sp.toString();
}
