// Pure sort helpers for the Active alerts table on /alerts. Kept React-free
// so it can be unit tested under `node --test` without dragging the UI in.
import type { Alert } from "@/lib/api";

export type AlertSortKey = "ticker" | "value" | "last_fired" | "cooldown";
export type AlertSortDir = "asc" | "desc";

function cmpStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function numericValue(v: Alert["value"]): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function lastFiredMs(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Pure sort over the alerts list. Returns a new array; never mutates input.
 *
 * - ticker: lexicographic on ticker symbol.
 * - value: numeric on the trigger value (strings parsed; non-numerics treated as 0).
 * - cooldown: numeric on cooldown_hours.
 * - last_fired: chronological. Never-fired alerts (null) always sort to the
 *   bottom regardless of direction so a fresh roster does not bury fires.
 */
export function sortAlerts(alerts: Alert[], key: AlertSortKey, dir: AlertSortDir): Alert[] {
  const sign = dir === "asc" ? 1 : -1;
  const copy = alerts.slice();
  copy.sort((a, b) => {
    let primary = 0;
    if (key === "ticker") {
      primary = cmpStrings(a.ticker ?? "", b.ticker ?? "");
    } else if (key === "value") {
      primary = numericValue(a.value) - numericValue(b.value);
    } else if (key === "cooldown") {
      primary = (a.cooldown_hours ?? 0) - (b.cooldown_hours ?? 0);
    } else if (key === "last_fired") {
      const av = lastFiredMs(a.last_fired_at);
      const bv = lastFiredMs(b.last_fired_at);
      if (av === null && bv === null) primary = 0;
      else if (av === null) return 1; // never-fired sinks regardless of dir
      else if (bv === null) return -1;
      else primary = av - bv;
    }
    if (primary !== 0) return primary * sign;
    // Stable secondary on ticker then id so equal keys do not jitter.
    const t = cmpStrings(a.ticker ?? "", b.ticker ?? "");
    if (t !== 0) return t;
    return cmpStrings(a.id ?? "", b.id ?? "");
  });
  return copy;
}
