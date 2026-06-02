// Pure helpers for the /correlation deep-link query string. Kept React-free
// so they run under `node --experimental-strip-types --test`.
//
// Two knobs drive the page: the rolling window in bars and the cluster
// threshold. Mirroring them in the URL lets users share a specific view of
// the matrix the same way /watchlist and /journal already do.

export const CORR_WINDOW_DEFAULT = 60;
export const CORR_WINDOW_MIN = 5;
export const CORR_WINDOW_MAX = 500;

export const CORR_THRESHOLD_DEFAULT = 0.7;
export const CORR_THRESHOLD_MIN = 0.1;
export const CORR_THRESHOLD_MAX = 0.99;

export type CorrelationUrlState = {
  window: number;
  threshold: number;
};

function clampWindow(n: number): number {
  if (!Number.isFinite(n)) return CORR_WINDOW_DEFAULT;
  const i = Math.trunc(n);
  if (i < CORR_WINDOW_MIN) return CORR_WINDOW_MIN;
  if (i > CORR_WINDOW_MAX) return CORR_WINDOW_MAX;
  return i;
}

function clampThreshold(n: number): number {
  if (!Number.isFinite(n)) return CORR_THRESHOLD_DEFAULT;
  if (n < CORR_THRESHOLD_MIN) return CORR_THRESHOLD_MIN;
  if (n > CORR_THRESHOLD_MAX) return CORR_THRESHOLD_MAX;
  // Round to two decimals so the URL stays short and stable across edits.
  return Math.round(n * 100) / 100;
}

/**
 * Parse the /correlation query string into a normalized state. Out-of-range
 * or unparseable values fall back to defaults so a hand-edited URL never
 * lands the page in a broken state.
 */
export function parseCorrelationUrlState(
  search: string | URLSearchParams,
): CorrelationUrlState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const rawWindow = sp.get("window");
  const rawThreshold = sp.get("threshold");
  const window = rawWindow === null || rawWindow === ""
    ? CORR_WINDOW_DEFAULT
    : clampWindow(Number(rawWindow));
  const threshold = rawThreshold === null || rawThreshold === ""
    ? CORR_THRESHOLD_DEFAULT
    : clampThreshold(Number(rawThreshold));
  return { window, threshold };
}

/**
 * Serialize state back to a query string. Defaults are omitted so the bare
 * /correlation URL stays clean when nothing has been customized.
 */
export function serializeCorrelationUrlState(state: CorrelationUrlState): string {
  const sp = new URLSearchParams();
  const w = clampWindow(state.window);
  const t = clampThreshold(state.threshold);
  if (w !== CORR_WINDOW_DEFAULT) sp.set("window", String(w));
  if (t !== CORR_THRESHOLD_DEFAULT) sp.set("threshold", String(t));
  return sp.toString();
}
