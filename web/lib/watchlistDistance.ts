// Pure helpers for showing how close the last close is to a watchlist
// target, used by the /watchlist UI. Kept dependency-free so it can be
// unit tested under node --test without React/Next in the loop.

export type TargetDistance = {
  side: "high" | "low";
  // Signed percent of close: positive means close is above the low target
  // (needs to fall to trip it), negative means close is below the high
  // target (needs to rise to trip it).
  pct: number;
  // Absolute price gap, always positive.
  abs: number;
};

export function nearestTargetDistance(
  close: number | null | undefined,
  targetHigh: number | null | undefined,
  targetLow: number | null | undefined,
): TargetDistance | null {
  if (close === null || close === undefined) return null;
  if (!Number.isFinite(close) || close <= 0) return null;
  const candidates: TargetDistance[] = [];
  if (
    targetHigh !== null &&
    targetHigh !== undefined &&
    Number.isFinite(targetHigh) &&
    close < targetHigh
  ) {
    const abs = targetHigh - close;
    candidates.push({ side: "high", abs, pct: -(abs / close) * 100 });
  }
  if (
    targetLow !== null &&
    targetLow !== undefined &&
    Number.isFinite(targetLow) &&
    close > targetLow
  ) {
    const abs = close - targetLow;
    candidates.push({ side: "low", abs, pct: (abs / close) * 100 });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a.pct) - Math.abs(b.pct));
  return candidates[0];
}

export function formatTargetDistancePct(pct: number): string {
  const v = Math.abs(pct);
  const digits = v < 10 ? 2 : 1;
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  return `${sign}${v.toFixed(digits)}%`;
}
