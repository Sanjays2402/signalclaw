// Pure helpers for comparing two saved regime runs.
// Kept in lib/ so the math is unit-testable without booting Next.

export const REGIME_ORDER = ["bull", "chop", "bear", "crash"] as const;
export type Regime = (typeof REGIME_ORDER)[number];

export type RunPayloadLike = {
  dates: string[];
  close: number[];
  counts: Record<string, number>;
  snapshot?: { label: string; confidence: number } | null;
};

export function regimeMix(payload: { counts: Record<string, number> }): {
  total: number;
  mix: Record<Regime, number>;
} {
  let total = 0;
  for (const k of REGIME_ORDER) total += payload.counts[k] || 0;
  const mix = {} as Record<Regime, number>;
  for (const k of REGIME_ORDER) mix[k] = total > 0 ? (payload.counts[k] || 0) / total : 0;
  return { total, mix };
}

export function pctChange(close: number[]): number | null {
  if (!close || close.length < 2) return null;
  const a = close[0];
  const b = close[close.length - 1];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return (b - a) / a;
}

export function mixDiff(
  a: Record<Regime, number>,
  b: Record<Regime, number>,
): Record<Regime, number> {
  const out = {} as Record<Regime, number>;
  for (const k of REGIME_ORDER) out[k] = (b[k] || 0) - (a[k] || 0);
  return out;
}

// Validation helper for compare ids. Conservative charset to avoid path tricks.
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
export function isValidRunId(s: unknown): s is string {
  return typeof s === "string" && ID_RE.test(s);
}
