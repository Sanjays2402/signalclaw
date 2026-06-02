// Pure helpers for filtering the Active alerts table on /alerts.
// Kept side-effect free and unit tested in tests/alertFilter.test.mjs so the
// page can call into them without dragging React or SWR into the test harness.

import type { Alert } from "@/lib/api";

export type AlertStateFilter = "" | "enabled" | "disabled";

export type AlertFilterOpts = {
  /** Free-text query matched against ticker and note, case-insensitive. */
  query?: string;
  /** "" matches every alert, "enabled" keeps a.enabled === true, "disabled" the inverse. */
  state?: AlertStateFilter;
};

/**
 * Pure filter over the alert list. Empty / missing filter returns the input as-is
 * so the caller can pass `alerts` through without an extra branch. Matching is
 * case-insensitive and treats a missing note as empty string.
 */
export function filterAlerts(alerts: Alert[], opts: AlertFilterOpts = {}): Alert[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const state = opts.state ?? "";
  if (!q && !state) return alerts;
  return alerts.filter((a) => {
    if (state === "enabled" && !a.enabled) return false;
    if (state === "disabled" && a.enabled) return false;
    if (!q) return true;
    const ticker = (a.ticker ?? "").toLowerCase();
    const note = (a.note ?? "").toLowerCase();
    return ticker.includes(q) || note.includes(q);
  });
}
