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

// Side-by-side row shape used by the compare export. One row per metric,
// columns for A and B and the B minus A delta. Kept as a pure helper so the
// route handler stays thin and tests can pin the exact wire format.
export type CompareSummarySide = {
  bars: number;
  mix: Record<string, number>;
  regime: string | null;
  confidence: number | null;
  pct_change: number | null;
};

export type CompareSummary = {
  a: CompareSummarySide;
  b: CompareSummarySide;
  mix_diff: Record<string, number>;
};

export type CompareMeta = {
  a: { id: string; label: string; ticker: string; lookback_days: number; created_at: string };
  b: { id: string; label: string; ticker: string; lookback_days: number; created_at: string };
};

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function num(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  return String(n);
}

// Render the compare summary as a CSV with one row per metric.
// Columns: metric, a, b, delta. Header rows describe the two runs so the
// file is self-contained when opened in a spreadsheet.
export function compareToCSV(meta: CompareMeta, summary: CompareSummary): string {
  const lines: string[] = [];
  lines.push("# signalclaw compare export");
  lines.push(
    `# A,${csvEscape(meta.a.id)},${csvEscape(meta.a.ticker)},${csvEscape(meta.a.label)},${csvEscape(meta.a.lookback_days)}d,${csvEscape(meta.a.created_at)}`,
  );
  lines.push(
    `# B,${csvEscape(meta.b.id)},${csvEscape(meta.b.ticker)},${csvEscape(meta.b.label)},${csvEscape(meta.b.lookback_days)}d,${csvEscape(meta.b.created_at)}`,
  );
  lines.push(["metric", "a", "b", "delta"].join(","));
  const push = (metric: string, a: unknown, b: unknown, delta: unknown) => {
    lines.push([metric, a, b, delta].map(csvEscape).join(","));
  };
  push("bars", summary.a.bars, summary.b.bars, summary.b.bars - summary.a.bars);
  push("regime", summary.a.regime ?? "", summary.b.regime ?? "", "");
  push(
    "confidence",
    num(summary.a.confidence),
    num(summary.b.confidence),
    summary.a.confidence !== null && summary.b.confidence !== null
      ? summary.b.confidence - summary.a.confidence
      : "",
  );
  push(
    "pct_change",
    num(summary.a.pct_change),
    num(summary.b.pct_change),
    summary.a.pct_change !== null && summary.b.pct_change !== null
      ? summary.b.pct_change - summary.a.pct_change
      : "",
  );
  for (const k of REGIME_ORDER) {
    push(
      `mix_${k}`,
      summary.a.mix[k] ?? 0,
      summary.b.mix[k] ?? 0,
      summary.mix_diff[k] ?? 0,
    );
  }
  return lines.join("\n") + "\n";
}

// Filename helper. Stable, safe for Content-Disposition.
export function compareExportFilename(meta: CompareMeta, format: "csv" | "json"): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return `signalclaw-compare-${safe(meta.a.ticker)}-vs-${safe(meta.b.ticker)}-${safe(meta.a.id)}-${safe(meta.b.id)}.${format}`;
}
